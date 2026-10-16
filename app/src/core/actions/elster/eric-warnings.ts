/**
 * Is the ERiC in use too old for what the app is about to do? Pure functions over an
 * already-probed status — no disk, no native binding — so every branch is unit-testable.
 *
 * The ERiC RELEASE number (download name, `ERIC_VERSION` in release.yml) is not what the libraries
 * report: the official 44.3.6.0 package says `libericapi` = 44.3.4.0. Comparisons therefore use the
 * reported library version; the table below maps a release to it so the UI can still show the
 * number ELSTER's download page uses. A table, not a build-time probe of the bundled archive,
 * because the archive lives in a private repo that forks and outside PRs cannot read;
 * `eric-warnings.test.ts` pins the table to `ERIC_VERSION` so a bump cannot forget it.
 */

import { _, fmt } from '../../lib/i18n.ts';

/** ERiC release → the `libericapi` version its `EricVersion` reports. Add a row per release shipped. */
export const ERIC_RELEASES: Readonly<Record<string, string>> = {
    '44.3.6.0': '44.3.4.0',
};

/** The release official builds bundle (release.yml `ERIC_VERSION`). */
export const BUNDLED_ERIC_RELEASE = '44.3.6.0';

/** The `libericapi` version of {@link BUNDLED_ERIC_RELEASE}: anything older is out of date. */
export const EXPECTED_ERIC_LIBRARY = ERIC_RELEASES[BUNDLED_ERIC_RELEASE];

/** Where the user gets a current ERiC. */
export const ERIC_DOWNLOAD_URL = 'https://www.elster.de/elsterweb/entwickler/infoseite/eric';

/** `44.3.4.0` → `[44, 3, 4, 0]`; null when it is not a dotted number. */
function parts(version: string): number[] | null {
    const p = version.split('.').map((s) => Number(s));
    return p.length > 0 && p.every((n) => Number.isInteger(n) && n >= 0) ? p : null;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal; null when either is unparsable. */
export function compareEricVersions(a: string, b: string): number | null {
    const pa = parts(a);
    const pb = parts(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** The release a reported library version belongs to ("44.3.4.0" → "44.3.6.0"), or null when unknown. */
export function releaseForLibrary(library: string): string | null {
    return Object.entries(ERIC_RELEASES).find(([, lib]) => lib === library)?.[0] ?? null;
}

/**
 * "ERiC 44.3.6.0 (Bibliothek 44.3.4.0)" when the release is known, so the number matches ELSTER's
 * download page; otherwise "ERiC-Bibliothek 44.3.4.0". Null in, null out.
 */
export function ericVersionLabel(library: string | null): string | null {
    if (!library) return null;
    const release = releaseForLibrary(library);
    return release
        ? fmt(_('ERiC {release} (library {library})'), { release, library })
        : fmt(_('ERiC library {library}'), { library });
}

/** One reason to doubt the installed ERiC; a hint, never a blocker. */
export type EricWarning =
    | { kind: 'outdated'; found: string; expected: string }
    | { kind: 'missing-plugin'; plugin: string };

/** The warning when the found library is older than the one official builds bundle. */
export function outdatedWarning(library: string | null): EricWarning | null {
    if (!library) return null;
    const cmp = compareEricVersions(library, EXPECTED_ERIC_LIBRARY);
    return cmp !== null && cmp < 0 ? { kind: 'outdated', found: library, expected: EXPECTED_ERIC_LIBRARY } : null;
}

/**
 * Warnings for sending one datenartVersion (`UStVA_2026`): the plugin `checkUStVA_2026` must exist.
 * `plugins` are the base names found in the runtime; an empty list means the runtime could not be
 * read, which says nothing about the plugin, so no warning.
 */
export function missingPluginWarning(datenartVersion: string, plugins: readonly string[]): EricWarning | null {
    if (plugins.length === 0) return null;
    const plugin = `check${datenartVersion}`;
    return plugins.includes(plugin) ? null : { kind: 'missing-plugin', plugin };
}

/** The user-facing sentence for a warning, translated. */
export function ericWarningText(w: EricWarning): string {
    if (w.kind === 'outdated') {
        return fmt(
            _(
                'This ERiC (library {found}) is older than the one bundled with official builds ({expected}). ELSTER may reject submissions from an ERiC whose support period has ended — download a current one.',
            ),
            { found: w.found, expected: w.expected },
        );
    }
    return fmt(
        _('This ERiC has no check plugin {plugin} for this form and year. Sending may fail — download a current ERiC.'),
        { plugin: w.plugin },
    );
}
