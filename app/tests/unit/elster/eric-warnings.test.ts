/**
 * The "your ERiC is old" hints: version comparison against the bundled library, the
 * release ↔ library mapping, and the per-form check plugin. Everything runs on a synthetic
 * `EricVersion` XML — no ERiC binary involved.
 */

import { describe, expect, it } from '@gjsify/unit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseEricVersion } from '../../../src/core/actions/elster/eric-status.ts';
import {
    BUNDLED_ERIC_RELEASE,
    ERIC_RELEASES,
    EXPECTED_ERIC_LIBRARY,
    compareEricVersions,
    ericVersionLabel,
    ericWarningText,
    missingPluginWarning,
    outdatedWarning,
    releaseForLibrary,
} from '../../../src/core/actions/elster/eric-warnings.ts';
import { datenartVersionFor } from '../../../src/core/actions/elster/submit.ts';

/** Shape of ERiC's `EricVersion` answer, with invented product versions. */
function versionXml(ericapi: string): string {
    const lib = (name: string, version: string) =>
        `<Bibliothek><Name>${name}</Name><Produktversion>${version}</Produktversion></Bibliothek>`;
    return `<EricVersion>${lib('libcommondata.so', ericapi)}${lib('libericapi.so', ericapi)}${lib('libotto.so', '9, 9, 9, 9')}</EricVersion>`;
}

export default async () => {
    await describe('ERiC outdated warning', async () => {
        await it('stays silent for the library the bundled release reports', async () => {
            const found = parseEricVersion(versionXml('44, 3, 4, 0'));
            expect(found).toBe('44.3.4.0');
            expect(found).toBe(EXPECTED_ERIC_LIBRARY);
            expect(outdatedWarning(found)).toBeNull();
        });

        await it('stays silent for a newer library', async () => {
            expect(outdatedWarning(parseEricVersion(versionXml('45, 1, 0, 0')))).toBeNull();
        });

        await it('warns for an older library and names both versions', async () => {
            const warning = outdatedWarning(parseEricVersion(versionXml('42, 3, 2, 0')));
            expect(warning?.kind).toBe('outdated');
            const text = ericWarningText(warning!);
            expect(text.includes('42.3.2.0')).toBe(true);
            expect(text.includes(EXPECTED_ERIC_LIBRARY)).toBe(true);
        });

        await it('compares numerically, not as text', async () => {
            expect(compareEricVersions('44.10.0.0', '44.3.4.0')! > 0).toBe(true);
            expect(compareEricVersions('44.3.4', '44.3.4.0')).toBe(0);
            expect(compareEricVersions('x', '44.3.4.0')).toBeNull();
            expect(outdatedWarning(null)).toBeNull();
        });
    });

    await describe('ERiC version label', async () => {
        await it('shows release and library when the mapping is known', async () => {
            expect(ericVersionLabel('44.3.4.0')).toBe('ERiC 44.3.6.0 (library 44.3.4.0)');
            expect(releaseForLibrary('44.3.4.0')).toBe('44.3.6.0');
        });

        await it('falls back to the library alone for an unknown release', async () => {
            expect(ericVersionLabel('45.1.0.0')).toBe('ERiC library 45.1.0.0');
            expect(ericVersionLabel(null)).toBeNull();
        });

        await it('maps the release the pipeline bundles', async () => {
            expect(ERIC_RELEASES[BUNDLED_ERIC_RELEASE]).toBe(EXPECTED_ERIC_LIBRARY);
            // A bump of ERIC_VERSION without a new table row would make every official build warn.
            const workflow = join(process.cwd(), '..', '.github', 'workflows', 'release.yml');
            if (existsSync(workflow)) {
                const m = /ERIC_VERSION:\s*"([\d.]+)"/.exec(readFileSync(workflow, 'utf8'));
                expect(m?.[1]).toBe(BUNDLED_ERIC_RELEASE);
            }
        });
    });

    await describe('missing check plugin per form and year', async () => {
        const plugins = ['checkUStVA_2025', 'checkUStVA_2026', 'checkEUER_2025', 'checkUSt_2025'];
        const missingOf = (datenart: string): string | null => {
            const w = missingPluginWarning(datenart, plugins);
            return w?.kind === 'missing-plugin' ? w.plugin : null;
        };

        await it('is silent when the plugin of the form and year exists', async () => {
            expect(missingPluginWarning(datenartVersionFor('euer', 2025, ''), plugins)).toBeNull();
            expect(missingPluginWarning(datenartVersionFor('ustva', 2026, ''), plugins)).toBeNull();
        });

        await it('names the plugin that is missing for another year or form', async () => {
            expect(missingOf(datenartVersionFor('euer', 2026, ''))).toBe('checkEUER_2026');
            expect(missingPluginWarning(datenartVersionFor('gewst', 2025, ''), plugins)?.kind).toBe('missing-plugin');
        });

        await it('reads the USt-VA year from the namespace of the snapshot', async () => {
            const xml = '<Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v2027"/>';
            expect(missingOf(datenartVersionFor('ustva', 2026, xml))).toBe('checkUStVA_2027');
        });

        await it('calls a year newer than every plugin of the form "upcoming", not broken', async () => {
            const w = missingPluginWarning(datenartVersionFor('euer', 2026, ''), plugins);
            expect(w?.kind === 'missing-plugin' && w.upcoming).toBe(true);
            const text = ericWarningText(w!);
            expect(text.includes('2026')).toBe(true);
            expect(text.includes('later ERiC release')).toBe(true);
            expect(text.includes('Nothing is broken')).toBe(true);
        });

        await it('keeps the broken-install wording when a plugin of the form is missing for an older year', async () => {
            const w = missingPluginWarning('EUER_2024', ['checkEUER_2025', 'checkEUER_2026']);
            expect(w?.kind === 'missing-plugin' && w.upcoming).toBe(false);
            expect(ericWarningText(w!).includes('no check plugin')).toBe(true);
        });

        await it('keeps the broken-install wording when the form has no plugin at all', async () => {
            const w = missingPluginWarning(datenartVersionFor('gewst', 2025, ''), plugins);
            expect(w?.kind === 'missing-plugin' && w.upcoming).toBe(false);
        });

        await it('says nothing when the plugin list could not be read', async () => {
            expect(missingPluginWarning('UStVA_2026', [])).toBeNull();
        });
    });
};
