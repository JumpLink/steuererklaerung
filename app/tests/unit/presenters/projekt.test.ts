import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    legeProjektRegelAn,
    loadProjektAnsicht,
    loeseProjektRegel,
    nimmProjektZuordnungZurueck,
    projektRegelVorschau,
    weiseProjektZu,
} from '../../../src/core/presenters/projekt.ts';
import type { PresenterSession } from '../../../src/core/presenters/session.ts';
import type { EntityModel } from '../../../src/core/presenters/workspace.ts';
import { aggregateEuerByTransactions } from '../../../src/core/elster/euer-transactions.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

// Invented bookings, customers and amounts.
const txs: UnifiedTransaction[] = [
    tx('b1', -119, '2026-02-03', 'Küstenlicht Bildagentur', 'Bürobedarf Bildlizenz Hafenlicht'),
    tx('b2', -59.5, '2026-03-04', 'Küstenlicht Bildagentur', 'Bürobedarf Bildlizenz Leuchtturm'),
    tx('b3', -35.7, '2026-04-05', 'Nordtype Schriftgießerei', 'Bürobedarf Schrift'),
    tx('b4', 1190, '2026-05-06', 'Hafenlicht GmbH', 'Rechnung RE-2026-0001'),
    tx('b5', -23.8, '2026-06-07', 'Wellenrausch Cafe', 'Bürobedarf Kaffee'),
];

function tx(
    id: string,
    amount: number,
    bookingDate: string,
    counterparty: string,
    purpose: string,
): UnifiedTransaction {
    return { id, source: 'camt', accountKey: 'camt:test', bookingDate, amount, currency: 'EUR', counterparty, purpose };
}

const session = {
    elster: () => ({ account_labels: {} }) as unknown as ElsterConfig,
    aggregate: async () => aggregateEuerByTransactions(txs, new Map(), 2026, { detail: true }),
    documents: async () => ({ docs: [], dmsKind: 'builtin' as const }),
    invalidate: () => {},
} as unknown as PresenterSession;

const entity = {
    id: 'firma',
    name: 'Beispiel GbR',
    kind: 'gbr',
    hasElster: true,
    hasEst: false,
    years: [2026],
    defaultYear: 2026,
    accountKeys: [],
    dmsType: 'builtin',
} as EntityModel;

export default async () => {
    await describe('Projekt: Presenter', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};
        beforeEach(async () => {
            prev = { STEUER_WORKSPACE: process.env.STEUER_WORKSPACE, LEDGER_DB_PATH: process.env.LEDGER_DB_PATH };
            dir = mkdtempSync(join(tmpdir(), 'bh-projekt-presenter-'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [
                        {
                            id: 'firma',
                            name: 'Beispiel GbR',
                            kind: 'gbr',
                            accounts: [],
                            projects: [
                                { id: 'hafenlicht', name: 'Hafenlicht Relaunch', contactId: 'c_hafenlicht' },
                                { id: 'leuchtturm', name: 'Leuchtturm Shop', contactId: 'c_leuchtturm' },
                            ],
                        },
                    ],
                }),
            );
            process.env.STEUER_WORKSPACE = manifest;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
        });

        await it('assigns a multi-select, skips an income, and shows the costs in the project result', async () => {
            const r = await weiseProjektZu(session, entity, 2026, ['b1', 'b3', 'b4', 'nirgends'], 'hafenlicht');
            expect(r.zugeordnet.join()).toBe('b1,b3');
            expect(r.uebersprungen.map((u) => `${u.id}:${u.warum}`).join('|')).toBe(
                'b4:ist keine Ausgabe|nirgends:gehört nicht zu Beispiel GbR 2026',
            );
            const a = await loadProjektAnsicht(session, entity, 2026);
            const hafen = a.projekte.find((p) => p.projectId === 'hafenlicht')!;
            expect(hafen.kosten).toBe(130);
            expect(hafen.umsatz).toBe(0);
            expect(hafen.ergebnis).toBe(-130);
            expect(hafen.ausgaben.map((z) => z.txId).join()).toBe('b3,b1'); // newest first, like the rows
            expect(a.projekte.find((p) => p.projectId === 'leuchtturm')!.kosten).toBe(0);
            expect(a.buchungen.b1.projekte[0].herkunft).toBe('manuell');
            expect(a.buchungen.b2).toBe(undefined);
        });

        await it('refuses an unknown project and an empty selection', async () => {
            let msg = '';
            try {
                await weiseProjektZu(session, entity, 2026, ['b1'], 'gibt-es-nicht');
            } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg).toContain('gibt-es-nicht');
            msg = '';
            try {
                await weiseProjektZu(session, entity, 2026, ['b4'], 'hafenlicht');
            } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg).toContain('keine Ausgabe');
        });

        await it('previews a rule before saving, remembers it with the exceptions, and a decision wins', async () => {
            const v = await projektRegelVorschau(session, entity, 2026, ['b1', 'b2'], 'hafenlicht');
            expect(v.muster).toBe('Küstenlicht Bildagentur');
            expect(v.treffer.map((t) => t.id).join()).toBe('b2,b1');
            expect(v.treffer.every((t) => t.beispiel)).toBe(true);

            // A manual decision on b2 keeps it out of the preview.
            await weiseProjektZu(session, entity, 2026, ['b2'], 'leuchtturm');
            const nach = await projektRegelVorschau(session, entity, 2026, ['b1', 'b2'], 'hafenlicht');
            expect(nach.treffer.map((t) => t.id).join()).toBe('b1');
            expect(nach.nichtErfasst.map((n) => `${n.id}:${n.warum}`).join()).toBe(
                'b2:hat eine eigene Zuordnung — die gewinnt',
            );

            const r = await weiseProjektZu(session, entity, 2026, ['b1'], 'hafenlicht', {
                regel: { muster: v.muster, ausnahmen: ['b9'] },
            });
            expect(r.regel?.added).toBe(true);
            // b1 follows the rule now and needs no decision of its own.
            expect(r.viaRegel.join()).toBe('b1');
            expect(r.zugeordnet.length).toBe(0);
            const a = await loadProjektAnsicht(session, entity, 2026);
            expect(a.regeln.length).toBe(1);
            expect(a.regeln[0].ausnahmen?.join()).toBe('b9');
            expect(a.regeln[0].treffer).toBe(1);
            expect(a.buchungen.b1.projekte[0].herkunft).toBe('via Regel „Küstenlicht Bildagentur“');
            expect(a.buchungen.b1.hatEntscheidung).toBe(false);
            expect(a.projekte.find((p) => p.projectId === 'leuchtturm')!.kosten).toBe(50);
        });

        await it('a rule assigns later bookings without a decision and says so', async () => {
            legeProjektRegelAn(session, entity, 'nordtype', 'leuchtturm');
            const a = await loadProjektAnsicht(session, entity, 2026);
            expect(a.buchungen.b3.projekte[0].herkunft).toBe('via Regel „nordtype“');
            expect(a.buchungen.b3.projekte[0].art).toBe('regel');
            expect(a.buchungen.b3.hatEntscheidung).toBe(false);
            expect(a.projekte.find((p) => p.projectId === 'leuchtturm')!.kosten).toBe(30);
        });

        await it('„kein Projekt" takes a booking out of a rule, and taking it back restores the rule with a sentence', async () => {
            legeProjektRegelAn(session, entity, 'nordtype', 'leuchtturm');
            await weiseProjektZu(session, entity, 2026, ['b3'], null);
            let a = await loadProjektAnsicht(session, entity, 2026);
            expect(a.buchungen.b3.projekte.length).toBe(0);
            expect(a.buchungen.b3.ausgenommen).toBe(true);
            expect(a.projekte.find((p) => p.projectId === 'leuchtturm')!.kosten).toBe(0);

            const zurueck = await nimmProjektZuordnungZurueck(session, entity, 2026, ['b3']);
            expect(zurueck.zurueckgenommen[0].danach).toBe(
                'Danach gilt: via Regel „nordtype“ → Projekt „Leuchtturm Shop“.',
            );
            a = await loadProjektAnsicht(session, entity, 2026);
            expect(a.buchungen.b3.projekte[0].art).toBe('regel');
            expect(a.projekte.find((p) => p.projectId === 'leuchtturm')!.kosten).toBe(30);
        });

        await it('undoing a manual assignment without a rule leaves the booking without a project', async () => {
            await weiseProjektZu(session, entity, 2026, ['b1', 'b5'], 'hafenlicht');
            const zurueck = await nimmProjektZuordnungZurueck(session, entity, 2026, ['b1', 'b5', 'b2']);
            expect(zurueck.zurueckgenommen.map((z) => z.id).join()).toBe('b1,b5');
            expect(zurueck.zurueckgenommen[0].danach).toBe('Danach gilt: kein Projekt.');
            const a = await loadProjektAnsicht(session, entity, 2026);
            expect(Object.keys(a.buchungen).length).toBe(0);
            expect(a.projekte.every((p) => p.kosten === 0)).toBe(true);
        });

        await it("removes a rule and leaves the person's decisions alone", async () => {
            legeProjektRegelAn(session, entity, 'nordtype', 'leuchtturm');
            await weiseProjektZu(session, entity, 2026, ['b5'], 'leuchtturm');
            expect(loeseProjektRegel(session, entity, 'NORDTYPE')).toBe(true);
            const a = await loadProjektAnsicht(session, entity, 2026);
            expect(a.regeln.length).toBe(0);
            expect(a.buchungen.b3).toBe(undefined);
            expect(a.buchungen.b5.projekte[0].projectId).toBe('leuchtturm');
        });
    });
};
