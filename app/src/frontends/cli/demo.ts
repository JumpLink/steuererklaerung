import type { CommandModule } from 'yargs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
    upsertAccount,
    upsertStatements,
    openLedger,
    migrate,
    ledgerDbPath,
    upsertContact,
    listInvoices,
    createInvoiceDraft,
    finalizeInvoice,
    markInvoicePaid,
    markTimeEntriesInvoiced,
    listTimeEntries,
    upsertFiling,
    upsertTimeEntry,
} from '@steuererklaerung/store';
import { BuiltinDmsProvider } from '@steuererklaerung/dms';
import type { StoredInvoice } from '@steuererklaerung/store';
import { classifyStoredReceipt } from '../../core/actions/documents.ts';
import { buildCiiInvoiceXml } from '../../core/invoices/cii-xml.ts';
import { buildHybridPdf } from '../../core/lib/demo/hybrid-pdf.ts';
import { demoDir, isDemoMode } from '../../core/config/demo.ts';
import {
    buildDemoTransactions,
    buildDemoStatements,
    buildDemoContacts,
    buildDemoInvoices,
    buildDemoTimeEntries,
    buildDemoSegelschuleTimeEntries,
    buildDemoDocuments,
    buildDemoFilings,
    DEMO_ISSUER,
    type DemoDocument,
} from '../../core/lib/demo/dataset.ts';
import { runAndExit } from './output.ts';

interface DemoSeedResult {
    storeDir: string;
    ledgerPath: string;
    accounts: { key: string; total: number; added: number; updated: number }[];
    transactions: number;
    contacts: number;
    invoices: number;
    documents: number;
}

/** Fixed timestamp + entity for a byte-stable, deterministic seed (no Date.now). */
const SEED_AT = '2026-07-07T09:00:00.000Z';
const DEMO_ENTITY = 'gbr';

/** Find a demo transaction id by counterparty + booking date (to link a Beleg to it). */
function findTxId(
    data: ReturnType<typeof buildDemoTransactions>,
    counterparty: string,
    date: string,
): string | undefined {
    for (const acc of data) {
        const tx = acc.txs.find((t) => t.counterparty === counterparty && t.bookingDate === date);
        if (tx) return tx.id;
    }
    return undefined;
}

/**
 * Build a tiny but valid single-page PDF embedding an ASCII line — a placeholder Beleg scan. Distinct
 * text ⇒ distinct bytes ⇒ distinct content-addressed DMS id, so re-seeding stays idempotent. All-ASCII
 * so string length equals byte length and the xref offsets are correct.
 */
function makeMinimalPdf(asciiText: string): Uint8Array {
    const text = asciiText.replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1');
    const stream = `BT /F1 15 Tf 40 540 Td (${text}) Tj ET`;
    const objs = [
        '<</Type/Catalog/Pages 2 0 R>>',
        '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        '<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 595]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
        `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
        '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let i = 0; i < objs.length; i++) {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(pdf);
}

/** The invented supplier XRechnung inside the demo's e-invoice Beleg (net = gross ÷ 1.19, one 19 % line). */
function demoEInvoicePdf(b: DemoDocument): Uint8Array {
    const net = Math.round((b.gross / 1.19) * 100) / 100;
    const vat = Math.round((b.gross - net) * 100) / 100;
    const xml = buildCiiInvoiceXml({
        id: 'demo-e-rechnung',
        entityId: DEMO_ENTITY,
        kind: 'invoice',
        status: 'open',
        number: b.invoiceNumber,
        contactId: null,
        recipient: {
            name: 'Demo-Betrieb',
            address: 'Beispielweg 1',
            zip: '12345',
            city: 'Beispielstadt',
            countryCode: 'DE',
        },
        issuer: {
            name: b.correspondent,
            address: 'Musterstraße 5',
            zip: '23456',
            city: 'Musterhafen',
            countryCode: 'DE',
            vatId: 'DE000000000',
            kleinunternehmer: false,
            bank: { iban: 'DE00000000000000000000', accountHolder: b.correspondent },
        },
        issueDate: b.date,
        dueDate: null,
        performanceStart: null,
        performanceEnd: null,
        currency: 'EUR',
        iban: 'DE00000000000000000000',
        buyerReference: null,
        header: null,
        footer: null,
        terms: null,
        items: [
            {
                title: 'Büromaterial',
                description: null,
                quantity: 1,
                unit: null,
                unitPriceNet: net,
                vatRate: 0.19,
                net,
                vat,
                gross: b.gross,
            },
        ],
        totals: { net, vat, gross: b.gross, byRate: [] },
        stornoOfId: null,
        cancelledById: null,
        paidAt: null,
        paidTxId: null,
        archive: { dms: null, pdfDocumentId: null, xmlDocumentId: null },
        finalizedAt: SEED_AT,
        createdAt: SEED_AT,
        updatedAt: SEED_AT,
        createdBy: null,
    } as StoredInvoice);
    return buildHybridPdf({ xml, text: `Demo-Beleg | ${b.invoiceNumber} | ${b.gross.toFixed(2)} EUR` });
}

/**
 * Regenerate the committed demo transactions under `app/demo/transactions-data`. Always targets the
 * demo dir (independent of STEUER_DEMO) so it never touches the user's real store. Idempotent: stable
 * ids mean re-seeding upserts the same rows.
 */
async function seedDemo(): Promise<DemoSeedResult> {
    const dir = demoDir();
    // In demo mode applyDemoEnv() has already pointed both paths at the demo — or kept the ones set
    // explicitly, which is how the E2E scripts run on a throwaway COPY of it. Overriding them here
    // sent every such run's seed and writes into app/demo/ledger.db after all. Outside demo mode (a
    // plain `demo seed`) the env may name the user's real store, so the demo dir is forced.
    const keep = isDemoMode() && !!process.env.TRANSACTIONS_DATA_DIR && !!process.env.LEDGER_DB_PATH;
    const storeDir = keep ? process.env.TRANSACTIONS_DATA_DIR! : join(dir, 'transactions-data');
    mkdirSync(storeDir, { recursive: true });
    // Point BOTH the NDJSON store and the SQLite ledger at the demo dir for this one-shot command,
    // matching applyDemoEnv() so contacts/invoices/DMS metadata land in app/demo/ledger.db (where the
    // demo web app reads them) — never in the user's real store.
    process.env.TRANSACTIONS_DATA_DIR = storeDir;
    process.env.LEDGER_DB_PATH = keep ? process.env.LEDGER_DB_PATH! : join(dir, 'ledger.db');

    // ── transactions (NDJSON) ──
    const data = buildDemoTransactions();
    const accounts = data.map((a) => {
        const res = upsertAccount(a.key, a.txs);
        return { key: a.key, total: res.total, added: res.added, updated: res.updated };
    });
    const transactions = accounts.reduce((sum, a) => sum + a.total, 0);
    const demoStatements = buildDemoStatements();
    upsertStatements(demoStatements.key, demoStatements.statements);

    // ── contacts + invoices (SQLite ledger) ──
    const ledgerPath = ledgerDbPath();
    const db = openLedger(ledgerPath);
    let contacts = 0;
    let invoices = 0;
    try {
        migrate(db);
        for (const c of buildDemoContacts()) {
            upsertContact(db, c, SEED_AT);
            contacts++;
        }
        // Invoices have no upsert (finalize allocates a running number) — seed only into an empty set.
        if (listInvoices(db, DEMO_ENTITY).length === 0) {
            for (const inv of buildDemoInvoices(new Date().toISOString().slice(0, 10))) {
                const draft = createInvoiceDraft(
                    db,
                    {
                        entityId: DEMO_ENTITY,
                        contactId: inv.contactId,
                        issueDate: inv.issueDate,
                        dueDate: inv.dueDate,
                        items: [{ title: inv.title, quantity: 1, unitPriceNet: inv.net, vatRate: 0.19 }],
                    },
                    SEED_AT,
                );
                finalizeInvoice(db, draft.id, { issuer: DEMO_ISSUER, recipient: { name: inv.recipient }, at: SEED_AT });
                if (inv.paid) {
                    const txId = inv.paidTx && findTxId(data, inv.paidTx.counterparty, inv.paidTx.date);
                    markInvoicePaid(db, draft.id, { paidAt: inv.paid, txId }, SEED_AT);
                }
                invoices++;
            }
        } else {
            invoices = listInvoices(db, DEMO_ENTITY).length;
        }
        // Tracked hours of the demo project (Idee 14); the entries billed on an invoice make it a project
        // invoice. Seeded once: an entity that has any time entry keeps what it has.
        if (listTimeEntries(db, { entityId: DEMO_ENTITY }).length === 0) {
            const invoices = listInvoices(db, DEMO_ENTITY);
            const billed = new Map<string, string[]>();
            for (const t of [...buildDemoTimeEntries(), ...buildDemoSegelschuleTimeEntries()]) {
                const start = `${t.date}T09:00:00.000Z`;
                upsertTimeEntry(
                    db,
                    {
                        id: t.id,
                        entityId: DEMO_ENTITY,
                        contactId: t.contactId,
                        project: t.project,
                        projectId: t.projectId,
                        description: t.description,
                        startedAt: start,
                        endedAt: new Date(Date.parse(start) + t.hours * 3600_000).toISOString(),
                        durationSeconds: Math.round(t.hours * 3600),
                    },
                    SEED_AT,
                );
                const invoice = t.billedTo && invoices.find((i) => i.items.some((it) => it.title === t.billedTo));
                if (invoice) billed.set(invoice.id, [...(billed.get(invoice.id) ?? []), t.id]);
            }
            for (const [invoiceId, ids] of billed) markTimeEntriesInvoiced(db, ids, invoiceId, SEED_AT);
        }
        // Filings upsert on (entity, kind, period), so re-seeding is idempotent.
        for (const f of buildDemoFilings()) upsertFiling(db, f, SEED_AT);
    } finally {
        db.close();
    }

    // ── documents / Belege (built-in DMS: PDF bytes under transactions-data/documents, metadata in the ledger) ──
    const provider = new BuiltinDmsProvider(DEMO_ENTITY);
    let documents = 0;
    for (const b of buildDemoDocuments()) {
        const net = Math.round((b.gross / 1.19) * 100) / 100;
        const bytes = b.eInvoice
            ? demoEInvoicePdf(b)
            : makeMinimalPdf(`Demo-Beleg | ${b.invoiceNumber} | ${b.gross.toFixed(2)} EUR`);
        const stored = await provider.store({
            bytes,
            filename: `${b.invoiceNumber}.pdf`,
            mimeType: 'application/pdf',
            created: b.date,
        });
        // The upload path's own reading: a hybrid PDF fills its fields from the XML, a plain one is
        // classified "sonstige Rechnung" — so the demo shows both badges.
        const doc = await classifyStoredReceipt(provider, stored, bytes);
        await provider.setMetadata(
            doc.id,
            b.eInvoice
                ? { documentType: b.docType, direction: 'incoming', tags: ['Demo'] }
                : {
                      correspondent: b.correspondent,
                      documentType: b.docType,
                      ...(b.category ? { category: b.category } : {}),
                      direction: 'incoming',
                      invoiceNumber: b.invoiceNumber,
                      ...(b.ohneUst ? {} : { net, vat: Math.round((b.gross - net) * 100) / 100 }),
                      gross: b.gross,
                      tags: ['Demo'],
                  },
        );
        const txId = b.link === false ? undefined : findTxId(data, b.correspondent, b.date);
        if (txId) await provider.link(doc.id, txId);
        documents++;
    }

    return { storeDir, ledgerPath, accounts, transactions, contacts, invoices, documents };
}

/**
 * Ensure the demo workspace is fully populated before a surface reads it. The demo
 * ledger is a gitignored derived artifact: on a fresh checkout the transactions
 * auto-import from the committed NDJSON, but contacts / invoices / DMS Belege only
 * exist after a seed. Without this, `--demo` web/app would show empty invoice and
 * receipt lists out of the box — the guided Beleg-Eingang and Rechnungen views
 * (the redesign's showcase) would look broken.
 *
 * No-op unless demo mode is active. Cheap when already seeded (a single
 * invoice-count query); runs the full seed only when the ledger has no invoices.
 */
export async function ensureDemoSeeded(): Promise<void> {
    if (!isDemoMode()) return;
    let seeded = false;
    try {
        const db = openLedger(ledgerDbPath());
        try {
            migrate(db);
            seeded = listInvoices(db, DEMO_ENTITY).length > 0;
        } finally {
            db.close();
        }
    } catch {
        // Ledger not readable yet (fresh demo) → treat as unseeded; seedDemo creates it.
    }
    if (seeded) return;
    await seedDemo();
}

function printSeed(r: DemoSeedResult): void {
    console.log(`\nDemo-Daten neu erzeugt → ${r.storeDir}`);
    console.log('='.repeat(56));
    for (const a of r.accounts) {
        console.log(`  ${a.key.padEnd(34)} ${String(a.total).padStart(4)} Buchungen  (+${a.added}/~${a.updated})`);
    }
    console.log(`  ${'gesamt'.padEnd(34)} ${String(r.transactions).padStart(4)}`);
    console.log(`\nLedger → ${r.ledgerPath}`);
    console.log(`  Kontakte: ${r.contacts} · Rechnungen: ${r.invoices} · Belege: ${r.documents}`);
    console.log('\nStarten mit:  STEUER_DEMO=1 steuer web   (oder: steuer web --demo)');
}

export const demoCommand: CommandModule = {
    command: 'demo',
    describe: 'Fiktive Demo-Firma (Fischer & Weber GbR) unter app/demo — zum Ausprobieren der App.',
    handler: () => {},
    builder: (y) =>
        y.demandCommand(1, 'Choose a subcommand: seed').command({
            command: 'seed',
            describe:
                'Committete Demo-Transaktionen unter app/demo/transactions-data neu erzeugen (deterministisch, idempotent).',
            handler: () => runAndExit(() => seedDemo(), { print: printSeed }),
        }),
};
