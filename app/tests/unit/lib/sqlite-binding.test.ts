/**
 * Regression guard: string parameters must be BOUND, never spliced into the SQL text.
 *
 * Until gjsify 0.32.0, `@gjsify/sqlite`'s StatementSync composed its SQL by
 * INTERPOLATION and escaped values the way SQLite quotes — double the apostrophe,
 * leave the backslash alone. The text then went to libgda's parser, which honours
 * `\` as an escape INSIDE a string literal, so a value ending in a backslash did
 * not close where SQLite says it closes. The statement finished early and
 * `Gda.SqlParser.parse_string()` handed back a `remain` pointer INTO the input,
 * declared `transfer-ownership="full"` — GJS called g_free() on an interior
 * pointer and glibc aborted. Not a failed query: SIGABRT, the whole process, no
 * catchable JS exception (gjsify#1062).
 *
 * This is not a theoretical input for us. `importTransactions` stores
 * `JSON.stringify(tx)` in `transactions.raw_json`, and JSON escaping emits a
 * backslash for every quote, newline and control character in a bank
 * Verwendungszweck. `document_ocr.text` takes raw OCR of scanned receipts,
 * `documents.file_path` takes filenames, and contacts/invoices take free text.
 *
 * So: assert round-trip fidelity for the values that used to take the process
 * down — through the public repo functions, not just a bare statement, so a
 * future re-splice anywhere in the chain is caught.
 */
import { describe, expect, it } from '@gjsify/unit';
import { migrate, openLedger, type UnifiedTransaction } from '@steuererklaerung/store';
import { importTransactions, seedChartOfAccounts, seedEntities, upsertAccounts } from '../../../src/core/lib/ledger/seed.ts';

const AT = '2026-08-13T10:00:00Z';

/** The shapes that desynchronised the literal, plus the ordinary text around them. */
const HOSTILE_STRINGS: Array<[label: string, value: string]> = [
    ['trailing backslash', 'ends with a backslash\\'],
    ['escaped apostrophe', "back\\'slash before quote"],
    ['doubled backslash', 'two\\\\backslashes'],
    ['JSON-ish escape', 'quote \\" inside'],
    ['newline escape', 'line\\nbreak'],
    ['bare apostrophe', "O'Brien & Co."],
    ['apostrophe after backslash', "path\\to\\O'Neill"],
    ['windows path', 'C:\\Belege\\2025\\Rechnung.pdf'],
    ['SQL comment', 'value -- not a comment'],
    ['statement separator', 'a; DROP TABLE transactions; --'],
];

function fresh() {
    const db = openLedger(':memory:');
    migrate(db);
    seedEntities(db);
    seedChartOfAccounts(db);
    return db;
}

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'x',
        source: 'camt',
        accountKey: 'camt:DE15',
        bookingDate: '2025-01-01',
        amount: -10,
        currency: 'EUR',
        ...over,
    };
}

export default async () => {
    await describe('sqlite string parameters are bound, not spliced', async () => {
        await it('round-trips backslashes and quotes through a bound parameter', async () => {
            const db = fresh();
            const stmt = db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)');
            for (const [label, value] of HOSTILE_STRINGS) {
                stmt.run(AT, label, value);
            }
            const rows = db.prepare('SELECT action, detail FROM audit_log ORDER BY id').all() as Array<{
                action: string;
                detail: string;
            }>;
            expect(rows.length).toBe(HOSTILE_STRINGS.length);
            for (let i = 0; i < HOSTILE_STRINGS.length; i++) {
                // Byte-identical: a spliced value comes back re-escaped, truncated, or not at all.
                expect(rows[i].action).toBe(HOSTILE_STRINGS[i][0]);
                expect(rows[i].detail).toBe(HOSTILE_STRINGS[i][1]);
            }
            db.close();
        });

        await it('matches a hostile string in a WHERE clause', async () => {
            const db = fresh();
            const needle = 'C:\\Belege\\2025\\Rechnung.pdf';
            db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(AT, 'a', needle);
            db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(AT, 'b', 'something else');
            const hit = db.prepare('SELECT action FROM audit_log WHERE detail = ?').all(needle) as Array<{
                action: string;
            }>;
            // Splicing made the comparison text differ from the stored text, so this found nothing.
            expect(hit.length).toBe(1);
            expect(hit[0].action).toBe('a');
            db.close();
        });

        await it('imports transactions whose purpose carries backslashes', async () => {
            const db = fresh();
            const purpose = "Rechnung 2025\\03 O'Brien \\";
            const txs = [tx({ id: 't1', purpose, counterparty: 'Muster \\ GmbH' })];
            upsertAccounts(db, txs);
            const result = importTransactions(db, txs, AT);
            expect(result.added).toBe(1);

            const row = db.prepare('SELECT purpose, counterparty, raw_json FROM transactions').get() as {
                purpose: string;
                counterparty: string;
                raw_json: string;
            };
            expect(row.purpose).toBe(purpose);
            expect(row.counterparty).toBe('Muster \\ GmbH');
            // raw_json is JSON.stringify'd, so it carries the backslashes doubled again —
            // the exact input class that aborted the process on the mail importer.
            expect(JSON.parse(row.raw_json).purpose).toBe(purpose);
            db.close();
        });

        await it('keeps a separator inside a value from ending the statement', async () => {
            const db = fresh();
            db.prepare('INSERT INTO entities(id, name, note) VALUES(?, ?, ?)').run(
                'probe',
                "Muster'; DELETE FROM entities; --",
                null,
            );
            const row = db.prepare('SELECT name FROM entities WHERE id = ?').get('probe') as { name: string };
            expect(row.name).toBe("Muster'; DELETE FROM entities; --");
            // The seeded entities are still there — the value never became statement text.
            const n = db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number };
            expect(n.n > 1).toBe(true);
            db.close();
        });
    });
};
