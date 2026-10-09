/**
 * The manifest staleness token — the primitive behind the Einstellungen lost-update guard.
 *
 * The bug it exists for: the Einstellungen groups fill their widgets from the manifest ONCE and
 * then rebuild whole blocks from widget state on every field edit (`views/einstellungen/
 * betrieb-ust.ts` assembles all five required `betrieb` keys). `mutateManifest` re-reading the file
 * before writing does NOT catch that — the stale copy lives in the widgets — so a `betrieb.ort`
 * changed meanwhile by the CLI or the resident MCP server was silently reverted by the next
 * unrelated edit in the GUI.
 *
 * `manifestRevision` lets a holder ask "did the file move under me?". These tests pin that it
 * changes on a write, survives a no-op read, and reports absence rather than throwing.
 */
import { afterEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadManifest, manifestRevision, saveElsterBetrieb } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const ELSTER_SECTION = {
    entity_id: 'artcode',
    period: { year: 2025, quarter: 1 },
    betrieb: { name: 'Muster GbR', strasse: 'Hauptstr. 1', plz: '12345', ort: 'Berlin', art: 'Software' },
};

export default async () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function fixture(): string {
        const { dir, path } = writeManifestFixture({
            entities: [{ id: 'gbr', name: 'Muster GbR', kind: 'gbr', elster: ELSTER_SECTION }],
        });
        dirs.push(dir);
        return path;
    }

    await describe('manifestRevision', async () => {
        await it('is stable across repeated reads of an unchanged file', async () => {
            const path = fixture();
            const a = manifestRevision(path);
            expect(a).toBeTruthy();
            loadManifest(path); // reading must not disturb the token
            expect(manifestRevision(path)).toBe(a);
        });

        await it('changes after a write through the normal config writers', async () => {
            const path = fixture();
            const before = manifestRevision(path);

            saveElsterBetrieb(
                'gbr',
                { name: 'Muster GbR', strasse: 'Hauptstr. 1', plz: '12345', ort: 'Hamburg', art: 'Software' },
                path,
            );

            expect(manifestRevision(path)).not.toBe(before);
        });

        await it('changes on SIZE alone, with the timestamp pinned to its original value', async () => {
            // A same-instant write on a coarse-grained filesystem would otherwise look unchanged.
            // The token carries the size for exactly that case — so pin mtime back to what it was
            // and assert the token STILL moved. Without restoring the timestamp this test would
            // pass on the mtime difference and prove nothing about the size.
            const path = fixture();
            // Pin the timestamp on BOTH sides rather than restoring the original: utimesSync
            // truncates to whole seconds here, so "restore what stat reported" silently changes
            // mtime and the test would pass on that instead of on the size.
            const stamp = new Date(1_700_000_000_000);
            utimesSync(path, stamp, stamp);
            const st = statSync(path);
            const before = manifestRevision(path);

            const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            raw['//'] = 'ein Kommentar, der die Datei laenger macht';
            writeFileSync(path, JSON.stringify(raw, null, 2));
            utimesSync(path, stamp, stamp);

            expect(statSync(path).mtimeMs).toBe(st.mtimeMs); // the timestamp really is unchanged
            expect(statSync(path).size).not.toBe(st.size); // …and only the size moved
            expect(manifestRevision(path)).not.toBe(before);
        });

        await it('reports null for a path that does not exist, instead of throwing', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-rev-'));
            dirs.push(dir);
            expect(manifestRevision(join(dir, 'steuererklaerung.json'))).toBe(null);
        });

        await it('goes from null to a token once the file appears', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-rev-'));
            dirs.push(dir);
            const path = join(dir, 'steuererklaerung.json');
            expect(manifestRevision(path)).toBe(null);
            writeFileSync(path, JSON.stringify({ version: 1, entities: [{ id: 'x', name: 'X' }] }));
            expect(manifestRevision(path)).toBeTruthy();
        });
    });
};
