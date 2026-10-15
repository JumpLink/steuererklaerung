/**
 * An entity on the built-in DMS (the demo, every fresh install) must never trigger a Paperless
 * call: without credentials it throws "PAPERLESS_BASE_URL not set" and the Abgabe tab never gets to
 * the snapshot, the §5 privacy dialog or the validation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { entityUsesPaperless, ustvaAusBuchungenAktiv } from '../../../src/core/actions/elster/ustva.ts';

function manifest(): string {
    const entity = (id: string, dms?: object) => ({
        id,
        name: id,
        kind: 'einzelunternehmen',
        accounts: [`qonto:${id}`],
        ...(dms ? { dms } : {}),
    });
    return JSON.stringify({
        version: 1,
        entities: [
            entity('eingebaut', { type: 'builtin' }),
            entity('ohne-dms'),
            entity('mit-paperless', { type: 'paperless' }),
        ],
    });
}

export default async () => {
    await describe('built-in DMS entities never ask Paperless', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'no-paperless-'));
            const file = join(dir, 'steuererklaerung.json');
            writeFileSync(file, manifest());
            vi.stubEnv('STEUER_WORKSPACE', file);
        });
        afterEach(() => {
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('a builtin entity does not use Paperless', async () => {
            expect(entityUsesPaperless('eingebaut')).toBe(false);
            expect(ustvaAusBuchungenAktiv('eingebaut')).toBe(true);
        });

        await it('an entity without a dms block does not use Paperless either', async () => {
            expect(entityUsesPaperless('ohne-dms')).toBe(false);
        });

        await it('only an explicit paperless entity does', async () => {
            expect(entityUsesPaperless('mit-paperless')).toBe(true);
        });
    });
};
