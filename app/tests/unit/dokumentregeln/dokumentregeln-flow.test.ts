/**
 * Dokumentregeln (Idee 11) end to end on the built-in DMS: remember, apply on upload, precedence
 * against hand edits and the AI, ausnahmen, undo. A counting provider proves the upload path makes
 * no AI call. All names invented.
 */
import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltinDmsProvider, applyExtraction } from '@steuererklaerung/dms';
import { setLLMProviderOverride, type LLMProvider } from '../../../src/core/clients/llm/index.ts';
import {
    applyDokumentRegeln,
    loadDokumentRegeln,
    nimmDokumentRegelZurueck,
    rememberDokumentRegel,
    removeDokumentRegel,
} from '../../../src/core/actions/dokumentregeln.ts';
import { storeReceipt, updateReceiptMetadata } from '../../../src/core/actions/documents.ts';

export default async () => {
    await describe('Dokumentregeln — Ablauf im eingebauten DMS', async () => {
        let dir = '';
        let calls = 0;
        const prev = new Map<string, string | undefined>();
        const setEnv = (k: string, v: string) => {
            if (!prev.has(k)) prev.set(k, process.env[k]);
            process.env[k] = v;
        };
        const counting: LLMProvider = {
            name: 'zaehler',
            model: 'keins',
            complete: async () => {
                calls++;
                throw new Error('Die KI wurde gerufen, obwohl eine Regel alles setzt.');
            },
        };
        const manifestPath = () => join(dir, 'steuererklaerung.json');
        const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n`);

        beforeEach(() => {
            calls = 0;
            dir = mkdtempSync(join(tmpdir(), 'bh-dokregel-'));
            setEnv('TRANSACTIONS_DATA_DIR', dir);
            setEnv('LEDGER_DB_PATH', join(dir, 'ledger.db'));
            writeFileSync(
                manifestPath(),
                JSON.stringify({
                    version: 1,
                    entities: [
                        { id: 'gbr', name: 'Test GbR', kind: 'gbr', accounts: ['camt:*'], dms: { type: 'builtin' } },
                    ],
                }),
            );
            setEnv('STEUER_WORKSPACE', manifestPath());
            setLLMProviderOverride(counting);
        });
        afterEach(() => {
            setLLMProviderOverride(null);
            for (const [k, v] of prev) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            prev.clear();
            rmSync(dir, { recursive: true, force: true });
        });

        const telefon = {
            muster: 'Funknetz Beispiel',
            korrespondent: 'Funknetz Beispiel AG',
            dokumenttyp: 'Rechnung',
            kategorie: '4921 Telefon/Internet',
            richtung: 'incoming' as const,
        };

        await it('remembers a rule in the manifest; the same pattern updates instead of duplicating', async () => {
            expect(rememberDokumentRegel('gbr', telefon).added).toBe(true);
            expect(rememberDokumentRegel('gbr', telefon)).toStrictEqual({
                rule: telefon,
                added: false,
                changed: false,
            });
            const changed = rememberDokumentRegel('gbr', {
                ...telefon,
                muster: 'FUNKNETZ beispiel',
                dokumenttyp: 'Mahnung',
            });
            expect(changed.changed).toBe(true);
            expect(loadDokumentRegeln('gbr').length).toBe(1);
            const raw = JSON.parse(readFileSync(manifestPath(), 'utf8'));
            expect(raw.entities[0].elster.klassifizierung.beleg_regeln[0].dokumenttyp).toBe('Mahnung');
        });

        await it('refuses a rule without a pattern or without any value', async () => {
            let msg = '';
            try {
                rememberDokumentRegel('gbr', { muster: 'ab', dokumenttyp: 'X' });
            } catch (e) {
                msg = (e as Error).message;
            }
            expect(msg).toContain('mindestens');
            msg = '';
            try {
                rememberDokumentRegel('gbr', { muster: 'Funknetz' });
            } catch (e) {
                msg = (e as Error).message;
            }
            expect(msg).toContain('mindestens einen Wert');
        });

        await it('upload: a rule covering every field makes zero AI calls and shows its origin', async () => {
            rememberDokumentRegel('gbr', telefon);
            const dms = new BuiltinDmsProvider('gbr');
            const doc = await storeReceipt(dms, {
                bytes: pdf('Rechnung Funknetz Beispiel Februar'),
                filename: 'Funknetz Beispiel 2026-02.pdf',
                entityId: 'gbr',
            });
            expect(calls).toBe(0);
            expect(doc.correspondent).toBe('Funknetz Beispiel AG');
            expect(doc.documentType).toBe('Rechnung');
            expect(doc.category).toBe('4921 Telefon/Internet');
            expect(doc.direction).toBe('incoming');
            expect(doc.ruleOrigin?.label).toBe('„Funknetz Beispiel“');
            expect(doc.ruleOrigin?.fields.length).toBe(4);
        });

        await it('upload of a receipt no rule covers stays untouched', async () => {
            rememberDokumentRegel('gbr', telefon);
            const doc = await storeReceipt(new BuiltinDmsProvider('gbr'), {
                bytes: pdf('etwas anderes'),
                filename: 'Sonstiges.pdf',
                entityId: 'gbr',
            });
            expect(doc.ruleOrigin).toBe(null);
            expect(doc.documentType).toBe(null);
            expect(calls).toBe(0);
        });

        await it('the AI fills only what the rule left open', async () => {
            rememberDokumentRegel('gbr', {
                muster: 'Funknetz Beispiel',
                dokumenttyp: 'Rechnung',
                kategorie: '4921 Telefon/Internet',
            });
            const dms = new BuiltinDmsProvider('gbr');
            const doc = await storeReceipt(dms, {
                bytes: pdf('Funknetz Beispiel'),
                filename: 'Funknetz Beispiel.pdf',
                entityId: 'gbr',
            });
            expect(doc.ruleOrigin?.fields).toStrictEqual(['documentType', 'category']);
            await applyExtraction(
                dms,
                doc.id,
                {
                    metadata: {
                        invoiceNumber: 'F-1',
                        date: null,
                        correspondent: 'Funknetz Beispiel AG',
                        net: 10,
                        gross: 11.9,
                        vat: 1.9,
                        direction: 'incoming',
                    },
                    fullText: '',
                },
                doc.ruleOrigin?.fields,
            );
            const after = (await dms.get(doc.id))!;
            expect(after.correspondent).toBe('Funknetz Beispiel AG');
            expect(after.invoiceNumber).toBe('F-1');
            expect(after.category).toBe('4921 Telefon/Internet');
            expect(after.documentType).toBe('Rechnung');
        });

        await it('a hand edit wins: the changed field leaves the origin and keeps its value', async () => {
            rememberDokumentRegel('gbr', telefon);
            const dms = new BuiltinDmsProvider('gbr');
            const doc = await storeReceipt(dms, {
                bytes: pdf('Funknetz Beispiel'),
                filename: 'Funknetz Beispiel.pdf',
                entityId: 'gbr',
            });
            await updateReceiptMetadata(dms, doc.id, { category: '4964 Software/Lizenzen' });
            const after = (await dms.get(doc.id))!;
            expect(after.category).toBe('4964 Software/Lizenzen');
            expect(after.ruleOrigin?.fields.includes('category')).toBe(false);
            expect(after.ruleOrigin?.fields.includes('documentType')).toBe(true);
            // a later rule run does not touch the edited field
            const again = await applyDokumentRegeln(dms, after, loadDokumentRegeln('gbr'));
            expect(again.category).toBe('4964 Software/Lizenzen');
        });

        await it('zurücknehmen clears the rule values, says „Danach gilt“ and leaves the receipt out of the rule', async () => {
            rememberDokumentRegel('gbr', telefon);
            const dms = new BuiltinDmsProvider('gbr');
            const doc = await storeReceipt(dms, {
                bytes: pdf('Funknetz Beispiel'),
                filename: 'Funknetz Beispiel.pdf',
                entityId: 'gbr',
            });
            const res = await nimmDokumentRegelZurueck(dms, 'gbr', doc.id);
            expect(res.satz).toContain('Danach gilt:');
            const after = (await dms.get(doc.id))!;
            expect(after.documentType).toBe(null);
            expect(after.ruleOrigin).toBe(null);
            expect(loadDokumentRegeln('gbr')[0].ausnahmen).toStrictEqual([doc.id]);
            const again = await applyDokumentRegeln(dms, after, loadDokumentRegeln('gbr'));
            expect(again.ruleOrigin).toBe(null);
        });

        await it('removing a rule leaves filed receipts as they are', async () => {
            rememberDokumentRegel('gbr', telefon);
            const dms = new BuiltinDmsProvider('gbr');
            const doc = await storeReceipt(dms, {
                bytes: pdf('Funknetz Beispiel'),
                filename: 'Funknetz Beispiel.pdf',
                entityId: 'gbr',
            });
            expect(removeDokumentRegel('gbr', 'funknetz beispiel')).toBe(true);
            expect(removeDokumentRegel('gbr', 'funknetz beispiel')).toBe(false);
            expect((await dms.get(doc.id))!.category).toBe('4921 Telefon/Internet');
        });
    });
};
