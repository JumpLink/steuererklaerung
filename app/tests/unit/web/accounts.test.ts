import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFormat, upsertEnv } from '../../../src/core/actions/accounts.ts';

export default async () => {
    await describe('accounts.upsertEnv', async () => {
        await it('replaces existing keys and preserves other lines', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-env-'));
            const p = join(dir, '.env');
            writeFileSync(p, 'FOO=keep\nQONTO_PRODUCTION_SIGN_IN=old\n# a comment\n');
            const prev = process.env.DOTENV_CONFIG_PATH;
            process.env.DOTENV_CONFIG_PATH = p;
            try {
                upsertEnv({ QONTO_PRODUCTION_SIGN_IN: 'new', QONTO_PRODUCTION_SECRET_KEY: 'sek' });
                const out = readFileSync(p, 'utf-8');
                expect(out.includes('FOO=keep')).toBe(true);
                expect(out.includes('# a comment')).toBe(true);
                expect(out.includes('QONTO_PRODUCTION_SIGN_IN=new')).toBe(true);
                expect(out.includes('QONTO_PRODUCTION_SIGN_IN=old')).toBe(false);
                expect(out.includes('QONTO_PRODUCTION_SECRET_KEY=sek')).toBe(true);
            } finally {
                if (prev === undefined) delete process.env.DOTENV_CONFIG_PATH;
                else process.env.DOTENV_CONFIG_PATH = prev;
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    await describe('accounts.detectFormat', async () => {
        await it('maps XML to CAMT', async () => {
            expect(detectFormat('statements.xml')).toBe('camt');
            expect(detectFormat('FILE.XML')).toBe('camt'); // case-insensitive
        });
        await it('maps XLS/XLSX to the Qonto export', async () => {
            expect(detectFormat('export.xls')).toBe('qonto-xls');
            expect(detectFormat('Datenexport.xlsx')).toBe('qonto-xls');
        });
        await it('leaves CSV ambiguous (user picks PayPal vs Amazon)', async () => {
            expect(detectFormat('activity.csv')).toBe(null);
        });
        await it('returns null for an unknown / missing extension', async () => {
            expect(detectFormat('noext')).toBe(null);
            expect(detectFormat('archive.zip')).toBe(null);
        });
    });
};
