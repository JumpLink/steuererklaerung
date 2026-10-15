/**
 * ERiC garbles non-ASCII directory names on Windows ("Steuererklärung" → error 610001083, plugin
 * directory missing). The path handed to EricInitialisiere must be pure ASCII: unchanged when it
 * already is, else the 8.3 short form, else a copy under an ASCII directory.
 */

import { describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eric8bitPath, isAscii } from '../../../../packages/eric/src/ascii-path.ts';

export default async () => {
    await describe('eric8bitPath — ASCII-only paths for ERiC', async () => {
        const never = () => {
            throw new Error('short path must not be asked for an ASCII path');
        };

        await it('detects non-ASCII paths', async () => {
            expect(isAscii('C:\\Program Files\\Steuer\\plugins')).toBe(true);
            expect(isAscii('C:\\Program Files\\Steuererklärung\\plugins')).toBe(false);
        });

        await it('leaves an ASCII path untouched', async () => {
            const out = eric8bitPath('/opt/eric/plugins', { shortPath: never, fallbackDir: '/tmp/x', copyAs: 'plugins' });
            expect(out).toBe('/opt/eric/plugins');
        });

        await it('uses the 8.3 short form for a non-ASCII path', async () => {
            const out = eric8bitPath('C:\\Program Files\\Steuererklärung\\plugins', {
                shortPath: () => 'C:\\PROGRA~1\\STEUER~1\\plugins',
                fallbackDir: '/tmp/x',
                copyAs: 'plugins',
            });
            expect(out).toBe('C:\\PROGRA~1\\STEUER~1\\plugins');
        });

        await it('copies to the ASCII fallback when there is no usable short form', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-ascii-'));
            try {
                const src = join(root, 'Steuererklärung', 'plugins');
                mkdirSync(src, { recursive: true });
                writeFileSync(join(src, 'commonData.dll'), 'x');
                const fallbackDir = join(root, 'ascii');
                const out = eric8bitPath(src, { shortPath: () => undefined, fallbackDir, copyAs: 'plugins' });
                expect(out).toBe(join(fallbackDir, 'plugins'));
                expect(readFileSync(join(out, 'commonData.dll'), 'utf8')).toBe('x');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('returns the original when nothing works, so the real error shows', async () => {
            const missing = join(tmpdir(), 'does-not-exist-ä', 'plugins');
            const out = eric8bitPath(missing, { shortPath: () => undefined, fallbackDir: join(tmpdir(), 'a'), copyAs: 'plugins' });
            expect(out).toBe(missing);
            expect(existsSync(join(tmpdir(), 'a', 'plugins'))).toBe(false);
        });
    });
};
