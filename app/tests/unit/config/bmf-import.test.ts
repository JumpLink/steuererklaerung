import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseBmfCsv, fetchBmfCsv } from '../../../src/core/config/bmf-import.ts';
import { writeBmfRates } from '../../../src/core/config/bmf-rates.ts';

/** Encode a string to Windows-1252 bytes (the Latin-1 subset used here maps 1:1 to code units). */
const win1252 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// A faithful slice of the real BMF yearly CSV: title + header + tricky rows. Umlauts (Ü/ä/ü/ß) live
// in the title and country names to exercise Windows-1252 decoding; the rows cover dot-thousands
// (IDR), 5-decimal sub-1 (GBP), glued ISO codes (KRW Sep, RON Dez), a trailing space (ISK Jul), a
// comma inside the Land field (Korea) and an all-empty currency (Russland/RUB, suspended).
const FIXTURE = [
    'Monatlich fortgeschriebene Übersicht der Umsatzsteuer-Umrechnungskurse 2025 (Euro-Referenzkurse);;;;;;;;;;;;;',
    'Land;Währung;Januar[1];Februar [2];März [3];April [4];Mai [5];Juni [6];Juli [7];August [8];September [9];Oktober [10];November [11];Dezember [12]',
    'USA;1 Euro;1,0354 USD;1,0413 USD;1,0807 USD;1,1214 USD;1,1278 USD;1,1516 USD;1,1677 USD;1,1631 USD;1,1732 USD;1,1630 USD;1,1560 USD;1,1709 USD',
    'Indonesien;1 Euro;16.832,40 IDR;17.020,42 IDR;17.800,79 IDR;18.871,74 IDR;18.526,84 IDR;18.776,57 IDR;19.029,69 IDR;18.967,88 IDR;19.399,67 IDR;19.310,79 IDR;19.303,88 IDR;19.548,05 IDR',
    'Großbritannien;1 Euro;0,83908 GBP;0,83071 GBP;0,83703 GBP;0,85379 GBP;0,84350 GBP;0,84981 GBP;0,86469 GBP;0,86528 GBP;0,86895 GBP;0,87155 GBP;0,87997 GBP;0,87500 GBP',
    'Korea, Republik;1 Euro;1.503,60 KRW;1.505,02 KRW;1.576,45 KRW;1.617,41 KRW;1.566,14 KRW;1.573,37 KRW;1.608,95 KRW;1.617,15 KRW;1.634,39KRW;1.655,92 KRW;1.687,64 KRW;1.717,44 KRW',
    'Island;1 Euro;145,40 ISK;146,26 ISK;145,26 ISK;145,00 ISK;145,49 ISK;143,45 ISK;142,39 ISK ;143,10 ISK;142,98 ISK;142,22 ISK;146,83 ISK;148,19 ISK',
    'Rumänien;1 Euro;4,9752 RON;4,9770 RON;4,9768 RON;4,9775 RON;5,0714 RON;5,0454 RON;5,0716 RON;5,0651 RON;5,0740 RON;5,0872 RON;5,0867 RON;5,0913RON',
    'Türkei;1 Euro;36,8091 TRY;37,6927 TRY;40,1683 TRY;42,7740 TRY;43,7908 TRY;45,4347 TRY;46,9835 TRY;47,4983 TRY;48,4914 TRY;48,6799 TRY;48,8908 TRY;49,9695 TRY',
    'Russland1;1 Euro;;;;;;;;;;;;',
    '1 Die EZB hat die Veröffentlichung des Euro-Referenzkurses zum Rubel ausgesetzt.;;;;;;;;;;;;;',
].join('\r\n');

export default async () => {
    await describe('parseBmfCsv', async () => {
        const parsed = parseBmfCsv(win1252(FIXTURE));

        await it('reads the year from the (Windows-1252) title row', async () => {
            expect(parsed.year).toBe(2025);
        });

        await it('maps month columns to YYYY-MM keys with correct USD values', async () => {
            expect(parsed.rates['2025-01'].USD).toBe(1.0354);
            expect(parsed.rates['2025-07'].USD).toBe(1.1677); // July = 7th cell
            expect(parsed.rates['2025-12'].USD).toBe(1.1709);
        });

        await it('handles German thousands-dot / decimal-comma (IDR) and 5-decimal sub-1 (GBP)', async () => {
            expect(parsed.rates['2025-01'].IDR).toBe(16832.4);
            expect(parsed.rates['2025-01'].GBP).toBe(0.83908);
        });

        await it('tolerates glued ISO codes (KRW Sep, RON Dez) and a trailing space (ISK Jul)', async () => {
            expect(parsed.rates['2025-09'].KRW).toBe(1634.39); // "1.634,39KRW" — no space
            expect(parsed.rates['2025-12'].RON).toBe(5.0913); // "5,0913RON" — no space
            expect(parsed.rates['2025-07'].ISK).toBe(142.39); // "142,39 ISK " — trailing space
        });

        await it('splits on ";" only (Korea, Republik) and decodes umlaut Länder (Türkei)', async () => {
            expect(parsed.rates['2025-01'].KRW).toBe(1503.6); // comma inside Land did not break the split
            expect(parsed.rates['2025-07'].TRY).toBe(46.9835);
        });

        await it('skips empty cells → suspended RUB (Russland) yields no rate', async () => {
            expect(parsed.currencies).not.toContain('RUB');
            expect(parsed.rates['2025-01'].RUB).toBe(undefined);
        });

        await it('reports the currencies + populated cell count (7 currencies × 12 months)', async () => {
            // @gjsify/unit's toEqual compares arrays by ==, so assert on the joined string instead.
            expect(parsed.currencies.join(',')).toBe('GBP,IDR,ISK,KRW,RON,TRY,USD');
            expect(parsed.cells).toBe(84);
        });

        await it('rejects a non-CSV (bot-wall / wrong file)', async () => {
            let threw = false;
            try {
                parseBmfCsv(win1252('<!DOCTYPE html><html><body>Radware Captcha</body></html>'));
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });
    });

    await describe('writeBmfRates', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'bmf-'));
        const file = join(dir, 'bmf-umrechnungskurse.json');
        // Pre-existing file with a _comment (must survive) + one stale value + an unrelated year.
        writeFileSync(
            file,
            `${JSON.stringify({ _comment: 'KEEP ME', rates: { '2025-01': { USD: 9.9999 }, '2024-06': { USD: 1.08 } } }, null, 2)}\n`,
        );

        await it('merges new cells, preserves _comment + untouched entries, reports a diff', async () => {
            const summary = writeBmfRates(
                { '2025-01': { USD: 1.0354, IDR: 16832.4 }, '2025-02': { USD: 1.0413 } },
                file,
            );
            expect(summary.added).toBe(2); // IDR 2025-01 + USD 2025-02
            expect(summary.updated).toBe(1); // USD 2025-01: 9.9999 → 1.0354
            expect(summary.unchanged).toBe(0);

            const back = JSON.parse(readFileSync(file, 'utf-8')) as {
                _comment: string;
                rates: Record<string, Record<string, number>>;
            };
            expect(back._comment).toBe('KEEP ME'); // provenance note preserved
            expect(back.rates['2025-01'].USD).toBe(1.0354);
            expect(back.rates['2025-01'].IDR).toBe(16832.4);
            expect(back.rates['2025-02'].USD).toBe(1.0413);
            expect(back.rates['2024-06'].USD).toBe(1.08); // untouched year survives
        });

        await it('is idempotent (a second identical import rewrites byte-identically)', async () => {
            const before = readFileSync(file, 'utf-8');
            const summary = writeBmfRates(
                { '2025-01': { USD: 1.0354, IDR: 16832.4 }, '2025-02': { USD: 1.0413 } },
                file,
            );
            expect(summary.added).toBe(0);
            expect(summary.updated).toBe(0);
            expect(summary.unchanged).toBe(3);
            expect(readFileSync(file, 'utf-8')).toBe(before);
        });

        await it('creates a fresh file (with provenance _comment) when absent', async () => {
            const fresh = join(dir, 'new.json');
            writeBmfRates({ '2025-07': { USD: 1.1677 } }, fresh);
            const obj = JSON.parse(readFileSync(fresh, 'utf-8')) as {
                _comment: string;
                rates: Record<string, Record<string, number>>;
            };
            expect(typeof obj._comment).toBe('string');
            expect(obj._comment.length > 0).toBe(true);
            expect(obj.rates['2025-07'].USD).toBe(1.1677);
        });

        await it('replaces a hand-corrupted primitive month value instead of crashing', async () => {
            const f2 = join(dir, 'corrupt.json');
            // Without the per-month guard, `'USD' in 8.1` throws a cryptic TypeError.
            writeFileSync(f2, `${JSON.stringify({ _comment: 'x', rates: { '2025-03': 8.1 } }, null, 2)}\n`);
            const summary = writeBmfRates({ '2025-03': { USD: 1.0807 } }, f2);
            expect(summary.added).toBe(1);
            const back = JSON.parse(readFileSync(f2, 'utf-8')) as { rates: Record<string, Record<string, number>> };
            expect(back.rates['2025-03'].USD).toBe(1.0807);
        });

        await it('reconciles a hand-typed lowercase currency key (no duplicate)', async () => {
            const f3 = join(dir, 'lower.json');
            writeFileSync(f3, `${JSON.stringify({ _comment: 'x', rates: { '2025-01': { usd: 1.0354 } } }, null, 2)}\n`);
            const summary = writeBmfRates({ '2025-01': { USD: 1.0354 } }, f3);
            expect(summary.added).toBe(0);
            expect(summary.unchanged).toBe(1);
            const back = JSON.parse(readFileSync(f3, 'utf-8')) as { rates: Record<string, Record<string, number>> };
            expect(Object.keys(back.rates['2025-01']).join(',')).toBe('USD'); // no orphan "usd"
            expect(back.rates['2025-01'].USD).toBe(1.0354);
        });
    });

    await describe('fetchBmfCsv (bot-wall detection)', async () => {
        const orig = globalThis.fetch;
        const stub = (bytes: Uint8Array, init: { ok?: boolean; status?: number; url?: string } = {}): void => {
            const { ok = true, status = 200, url = 'https://www.bundesfinanzministerium.de/x' } = init;
            globalThis.fetch = (async () => ({
                ok,
                status,
                url,
                arrayBuffer: async () => bytes.buffer,
            })) as unknown as typeof fetch;
        };
        const restore = (): void => {
            globalThis.fetch = orig;
        };

        await it('returns the bytes when the response is a real CSV', async () => {
            stub(win1252(FIXTURE));
            try {
                const bytes = await fetchBmfCsv(2025);
                expect(new TextDecoder('windows-1252').decode(bytes.slice(0, 9))).toBe('Monatlich');
            } finally {
                restore();
            }
        });

        await it('throws (use --file) when a Radware challenge page is served with 200', async () => {
            stub(win1252('<!DOCTYPE html><html>Radware perfdrive challenge</html>'));
            let msg = '';
            try {
                await fetchBmfCsv(2025);
            } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            } finally {
                restore();
            }
            expect(/--file|Bot-Sperre/.test(msg)).toBe(true);
        });

        await it('throws on a non-OK HTTP status', async () => {
            stub(win1252('oops'), { ok: false, status: 500 });
            let threw = false;
            try {
                await fetchBmfCsv(2025);
            } catch {
                threw = true;
            } finally {
                restore();
            }
            expect(threw).toBe(true);
        });
    });
};
