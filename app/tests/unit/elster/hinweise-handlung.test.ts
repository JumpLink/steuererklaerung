import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeHinweise, hinweisFingerprint, BETROFFEN_MAX, type Hinweis } from '../../../src/core/elster/hinweise.ts';
import { ohneErledigte, markHinweisOk } from '../../../src/core/actions/elster/hinweise.ts';
import { buildHomeModel, hinweisTasks } from '../../../src/core/elster/home.ts';
import { importCamt } from '../../../src/core/actions/transactions.ts';
import { loadStatements } from '@steuererklaerung/store';

const find = (hs: Hinweis[], key: string) => hs.find((h) => h.key === key);

const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        id: `tx-${i}`,
        bookingDate: '2025-03-04',
        amount: -11.9,
        counterparty: `Lieferant ${i}`,
    }));

const camt = (stmts: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt>${stmts}</BkToCstmrStmt></Document>`;
const stmt = (seq: number, from: string, to: string, opening: number, closing: number, amount: number) => `
<Stmt><Id>S${seq}</Id><ElctrncSeqNb>${seq}</ElctrncSeqNb>
<FrToDt><FrDtTm>${from}T00:00:00</FrDtTm><ToDtTm>${to}T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${opening.toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${from}</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${closing.toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${to}</Dt></Dt></Bal>
<Ntry><Amt Ccy="EUR">${Math.abs(amount).toFixed(2)}</Amt><CdtDbtInd>${amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><BookgDt><Dt>${from}</Dt></BookgDt><ValDt><Dt>${from}</Dt></ValDt>
<NtryDtls><TxDtls><RmtInf><Ustrd>Testbuchung ${seq}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt>`;

export default async () => {
    await describe('Hinweis model — betroffen, handlungen, status', async () => {
        await it('stays backward compatible: counts alone give the plain hint, without betroffen', async () => {
            const hs = computeHinweise({ year: 2025, umsatz: 1000, outputVat: 190, unclassified: 2 });
            const u = find(hs, 'unklassifiziert')!;
            expect(u.title).toBe('2 unklassifizierte Buchung(en)');
            expect(u.status).toBe('befund');
            expect(u.betroffen).toBe(undefined);
            expect(u.handlungen).toBe(undefined);
            // Informational hints keep their old shape.
            expect(find(hs, 'kleinunternehmer')?.status).toBe(undefined);
        });

        await it('the migrated hints carry their bookings, actions and a fingerprint', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 1000,
                outputVat: 190,
                unclassified: 2,
                unclassifiedRows: rows(2),
                belegLuecke: { count: 1, sum: 1.9, rows: rows(1) },
            });
            const u = find(hs, 'unklassifiziert')!;
            expect(u.betroffen?.map((b) => b.id)).toStrictEqual(['tx-0', 'tx-1']);
            expect(u.betroffen?.[0].zeile).toBe('04.03.2025 · -11,90 € · Lieferant 0');
            expect(u.handlungen?.map((a) => a.id)).toStrictEqual(['regel-anlegen', 'buchungen', 'in-ordnung']);
            expect(u.fingerprint).toBe(hinweisFingerprint(['tx-1', 'tx-0']));
            const b = find(hs, 'beleg-luecke')!;
            expect(b.handlungen?.[0]).toStrictEqual({
                id: 'zuordnen',
                label: 'Zuordnen',
                target: { art: 'dialog', dialog: 'beleg-zuordnen', ref: 'tx-0' },
            });
        });

        await it('caps the list and counts the rest', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 0,
                outputVat: 0,
                unclassified: 25,
                unclassifiedRows: rows(25),
            });
            const u = find(hs, 'unklassifiziert')!;
            expect(u.betroffen?.length).toBe(BETROFFEN_MAX);
            expect(u.betroffenWeitere).toBe(25 - BETROFFEN_MAX);
        });

        await it('links the double-payment suspicion to its invoice — no second „in Ordnung"', async () => {
            const hs = computeHinweise({
                year: 2025,
                umsatz: 0,
                outputVat: 0,
                doppelzahlungVerdacht: 1,
                doppelzahlungVerdachtListe: [
                    { rechnungId: 'inv-7', rechnungNummer: 'RE-7', zuViel: 100, txs: [rows(1)[0]] },
                ],
            });
            const d = find(hs, 'doppelzahlung-verdacht')!;
            expect(d.betroffen?.[0]).toStrictEqual({
                art: 'rechnung',
                id: 'inv-7',
                zeile: 'Rechnung RE-7 · 100,00 € zu viel',
            });
            expect(d.handlungen?.map((a) => a.id)).toStrictEqual(['rechnung']);
        });
    });

    await describe('Als Nächstes — hints with an action become tasks', async () => {
        const befund: Hinweis = {
            key: 'unklassifiziert',
            level: 'warnung',
            title: '2 unklassifizierte Buchung(en)',
            text: '…',
            status: 'befund',
            betroffen: [
                { art: 'buchung', id: 'a', zeile: 'Z1' },
                { art: 'buchung', id: 'b', zeile: 'Z2' },
            ],
            handlungen: [
                {
                    id: 'regel-anlegen',
                    label: 'Regel anlegen',
                    target: { art: 'dialog', dialog: 'regel-anlegen', ref: 'a' },
                },
            ],
            fingerprint: 'x',
        };

        await it('a finding with an action appears; a check without finding does not', async () => {
            const tasks = hinweisTasks({
                year: 2025,
                txs: [],
                dashboard: null,
                hinweise: [
                    befund,
                    { ...befund, key: 'kontoauszug:x', status: 'ohne_befund' },
                    { ...befund, key: 'k2', handlungen: [] },
                ],
            });
            expect(tasks.length).toBe(1);
            expect(tasks[0]).toStrictEqual({
                title: '2 unklassifizierte Buchung(en)',
                sub: 'Z1 · und 1 weitere — Regel anlegen',
                tone: 'warn',
                kind: 'hinweis',
                ref: 'unklassifiziert',
                handlung: befund.handlungen![0],
            });
        });

        await it('a dismissed finding (filtered out upstream) leaves no task', async () => {
            const m = buildHomeModel({ year: 2025, txs: [], dashboard: null, hinweise: [] });
            expect(m.tasks.length).toBe(0);
        });

        await it('the double-payment hint is not repeated next to its own per-invoice task', async () => {
            const dz: Hinweis = { ...befund, key: 'doppelzahlung-verdacht' };
            const withOwn = buildHomeModel({
                year: 2025,
                txs: [],
                dashboard: null,
                hinweise: [dz],
                doppelzahlungVerdacht: [{ rechnungId: 'inv-1', rechnungNummer: 'RE-1', zuViel: 10 }],
            });
            expect(withOwn.tasks.map((t) => t.kind)).toStrictEqual(['doppelzahlung']);
            const without = buildHomeModel({ year: 2025, txs: [], dashboard: null, hinweise: [dz] });
            expect(without.tasks.map((t) => t.kind)).toStrictEqual(['hinweis']);
        });
    });

    await describe('Als in Ordnung markieren — persisted per finding', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};
        beforeEach(async () => {
            prev = {
                STEUER_WORKSPACE: process.env.STEUER_WORKSPACE,
                TRANSACTIONS_DATA_DIR: process.env.TRANSACTIONS_DATA_DIR,
            };
            dir = mkdtempSync(join(tmpdir(), 'bh-hinweis-ok-'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({ version: 1, entities: [{ id: 'test', name: 'Test', kind: 'privat', accounts: [] }] }),
            );
            process.env.STEUER_WORKSPACE = manifest;
            process.env.TRANSACTIONS_DATA_DIR = join(dir, 'transactions-data');
        });
        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
        });

        const hint = (ids: string[]): Hinweis =>
            computeHinweise({
                year: 2025,
                umsatz: 0,
                outputVat: 0,
                unclassified: ids.length,
                unclassifiedRows: ids.map((id) => ({ id, bookingDate: '2025-01-02', amount: -1 })),
            }).find((h) => h.key === 'unklassifiziert')!;

        await it('gone once marked, and stored with its fingerprint', async () => {
            const h = hint(['a', 'b']);
            markHinweisOk('test', h, 2025, { today: '2026-01-15' });
            expect(ohneErledigte([h], 2025, 'test').length).toBe(0);
            const flagged = ohneErledigte([h], 2025, 'test', true);
            expect(flagged[0].erledigt).toBe(true);
            const raw = JSON.parse(readFileSync(process.env.STEUER_WORKSPACE!, 'utf8'));
            expect(raw.entities[0].hinweise_geprueft).toStrictEqual([
                { hinweis: 'unklassifiziert', jahr: 2025, fingerprint: h.fingerprint, geprueft_am: '2026-01-15' },
            ]);
        });

        await it('a new finding under the same key comes back; another year is untouched', async () => {
            markHinweisOk('test', hint(['a', 'b']), 2025);
            expect(ohneErledigte([hint(['a', 'b', 'c'])], 2025, 'test').length).toBe(1);
            expect(ohneErledigte([hint(['a', 'b'])], 2026, 'test').length).toBe(1);
        });

        await it('refuses a hint without the action', async () => {
            const plain = computeHinweise({ year: 2025, umsatz: 0, outputVat: 0 })[0];
            let msg = '';
            try {
                markHinweisOk('test', plain, 2025);
            } catch (err) {
                msg = err instanceof Error ? err.message : String(err);
            }
            expect(msg).toContain('lässt sich nicht als in Ordnung markieren');
        });

        await it('a CAMT import records each statement’s period, number and balances', async () => {
            const file = join(dir, 'auszug.xml');
            writeFileSync(
                file,
                camt(
                    stmt(1, '2025-01-01', '2025-01-31', 100, 90, -10) +
                        stmt(2, '2025-02-01', '2025-02-28', 90, 110, 20),
                ),
            );
            importCamt(file);
            const st = loadStatements('camt:DE02120300000000202051');
            expect(st.length).toBe(2);
            expect(st[0]).toStrictEqual({
                from: '2025-01-01',
                to: '2025-01-31',
                opening: 100,
                closing: 90,
                seq: 1,
                sum: -10,
                count: 1,
                source: 'camt',
            });
            // Re-importing the same file does not double the statements.
            importCamt(file);
            expect(loadStatements('camt:DE02120300000000202051').length).toBe(2);
        });
    });
};
