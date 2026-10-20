/**
 * Core errors stay German for the CLI and MCP; the window words the ones it shows in its own
 * language through their `detail` (issue #133: an English UI showed "Kein Manifest unter …").
 */

import { describe, expect, it } from '@gjsify/unit';

import { BackupBusyError } from '../../../src/core/actions/backup.ts';
import { loadManifest } from '../../../src/core/config/manifest.ts';
import { ConfigError, isManifestMissing } from '../../../src/core/lib/errors.ts';
import { translateDetail } from '../../../src/frontends/desktop/error-detail-text.ts';

/** What the window shows when no catalogue answers: the English msgid. */
const identity = (msgid: string) => msgid;

/** The same decision as `errorText`, minus the GTK-bound catalogue. */
function errorText(err: unknown): string {
    const detail = (err as { detail?: Parameters<typeof translateDetail>[0] }).detail;
    const text = detail ? translateDetail(detail, identity) : null;
    return text ?? (err instanceof Error ? err.message : String(err));
}

export default async () => {
    await describe('errorText', async () => {
        await it('words a missing manifest in the UI language, not in German', async () => {
            let caught: unknown;
            try {
                loadManifest('/nonexistent/dir/steuererklaerung.json');
            } catch (err) {
                caught = err;
            }
            expect(isManifestMissing(caught)).toBe(true);
            // The message the CLI prints stays German ...
            expect((caught as Error).message.startsWith('Kein Manifest unter')).toBe(true);
            // ... the window's text does not (no catalogue in the test run, so: the English msgid).
            const text = errorText(caught);
            expect(text.startsWith('No configuration found at /nonexistent/dir/steuererklaerung.json')).toBe(true);
        });

        await it('fills the parameters of a backup error', async () => {
            const text = errorText(new BackupBusyError({ pid: 42, startedAt: 'today', reason: 'manual' }));
            expect(text).toBe('A backup is already running (process 42, since today).');
        });

        await it('falls back to the message without a detail or with an unknown code', async () => {
            expect(errorText(new ConfigError('Kaputt'))).toBe('Kaputt');
            expect(errorText(new ConfigError('Kaputt', undefined, { code: 'from-the-future' }))).toBe('Kaputt');
            expect(errorText('plain')).toBe('plain');
        });
    });
};
