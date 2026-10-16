/**
 * ERiC library status probe — the read side of the in-app ELSTER submission feature (Phase 1).
 *
 * The ERiC native library is not in the source repo (see @steuererklaerung/eric README): the app
 * validates ELSTER XML against it. Official release builds bundle it; otherwise the user installs
 * it and points the app at it via `config.eric_home` / the `ERIC_HOME` env var. This action reports, for a resolved home directory,
 * whether ERiC is available, its version, and (when incomplete) exactly what is missing — so a UI
 * can show the status and let the user set the path.
 *
 * Runtime-agnostic: the @steuererklaerung/eric facade is loaded via a dynamic import so the DESKTOP app
 * gets the GJS binding (index.gjs.ts) and the CLI/tests get the Node one (index.node.ts), exactly
 * like eric-cli.ts. A load failure of the native binding NEVER throws — it degrades to
 * `available:false` + `error`.
 */

import { ericPlatformKnown, setConfiguredEricHome, type EricHomeSource } from '@steuererklaerung/eric';

import { outdatedWarning, releaseForLibrary, type EricWarning } from './eric-warnings.ts';

/** Machine-readable ERiC availability snapshot for one resolved home directory. */
export interface EricStatus {
    /** ERiC is installed AND its native binding loaded (the version could be read). */
    available: boolean;
    /**
     * The version the `libericapi` library reports (e.g. "44.3.4.0"), or null when unavailable/unreadable.
     * Not the release number: official 44.3.6.0 reports 44.3.4.0 — see eric-warnings.ts.
     */
    version: string | null;
    /** The ERiC release `version` belongs to (e.g. "44.3.6.0"), when the mapping is known. */
    release: string | null;
    /** The resolved ERiC home directory that was probed (where the lib is expected). */
    ericHome: string;
    /** The resolved lib directory (`<ericHome>/lib`, `dll` on Windows) — where the ERiC library is expected. */
    libPath: string;
    /** Where ERiC writes its log files (licence § 15: they hold data from the filing and stay local). */
    logPath: string;
    /** Whether the runtime in use is the one shipped with the application. */
    bundled: boolean;
    /** Which rung of the search order `ericHome` came from (own folder, ERIC_HOME, bundled, …). */
    source: EricHomeSource;
    /** Required files missing from the runtime (empty when complete); see setup.ts requiredFiles. */
    missing: string[];
    /** Number of validation plugins found under `<ericHome>/lib/plugins`. */
    pluginCount: number;
    /** Base names of those plugins (`checkUStVA_2026`), for the per-form check in eric-warnings.ts. */
    plugins: string[];
    /** Doubts about this runtime that need no form (today: older than the bundled one). Never blocks. */
    warnings: EricWarning[];
    /** Present only when the files exist but loading/initialising the native binding failed. */
    error?: string;
    /** The native SteuerEric binding itself is unusable (stale prebuild), not ERiC: `error` is the raw GI text. */
    bindingBroken?: boolean;
    /**
     * False where no ERiC build exists (an architecture other than x86_64 / macOS). The UI says so
     * instead of asking the user to download something that would not be used.
     */
    platformSupported: boolean;
}

/** Whether ELSTER submission through ERiC can work on this OS at all (see {@link EricStatus.platformSupported}). */
export function ericPlatformSupported(platform: string = process.platform, arch: string = process.arch): boolean {
    return ericPlatformKnown(platform, arch);
}

/**
 * Make `config.eric_home` count: the fs probes and the native init then resolve the person's own
 * ERiC folder, ranked like `ERIC_HOME` above the bundled copy. A blank value clears it again, so
 * resetting the folder falls back to ERIC_HOME / bundled / auto-detection. Call this wherever ERiC
 * is about to be used from a loaded ELSTER config.
 */
export function applyEricHome(config: { eric_home?: string }): void {
    setConfiguredEricHome(config.eric_home);
}

/**
 * Probe ERiC for a given home directory.
 *
 * Resolution: an explicit `ericHome` wins (registered as the configured folder so the eric
 * package's path helpers pick it up); otherwise whatever {@link applyEricHome} registered, then the
 * `ERIC_HOME` env, the bundled copy and the defaults. First does the pure-fs availability + verification probe; only if the files are
 * present does it try to actually load the binding and read the version — wrapped so a load failure
 * (unbuilt binding, missing LD_LIBRARY_PATH, arch mismatch) yields `available:false` + `error`
 * instead of throwing.
 */
export async function getEricStatus(ericHome?: string): Promise<EricStatus> {
    const explicit = ericHome?.trim();
    if (explicit) setConfiguredEricHome(explicit);

    const eric = await import('@steuererklaerung/eric');
    const paths = eric.getEricPaths();
    const verification = eric.verifyInstallation();

    const base: EricStatus = {
        available: false,
        version: null,
        release: null,
        ericHome: paths.home,
        libPath: paths.lib,
        logPath: paths.logs,
        bundled: paths.source === 'bundled',
        source: paths.source,
        missing: verification.missing,
        pluginCount: verification.pluginCount,
        plugins: verification.pluginNames,
        warnings: [],
        platformSupported: ericPlatformSupported(),
    };

    if (!eric.isEricAvailable()) return base;

    // Files are present — try to load the native binding and read the version. Any failure here is
    // reported (not thrown): the lib is on disk but not usable in this runtime/environment.
    try {
        eric.initializeEric();
        const version = parseEricVersion(eric.getVersion());
        const outdated = outdatedWarning(version);
        return {
            ...base,
            available: true,
            version,
            release: version ? releaseForLibrary(version) : null,
            warnings: outdated ? [outdated] : [],
        };
    } catch (err) {
        return {
            ...base,
            available: false,
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof eric.EricBindingError ? { bindingBroken: true } : {}),
        };
    } finally {
        try {
            eric.shutdownEric();
        } catch {
            /* best-effort teardown */
        }
    }
}

/**
 * Extract a human-readable version from ERiC's `<EricVersion>` XML. Each `<Bibliothek>` carries a
 * comma-separated `<Produktversion>` (e.g. "44, 3, 6, 0"); we prefer the core `ericapi` library and
 * render it dotted ("44.3.6.0"). Falls back to any dotted version token, else null.
 */
export function parseEricVersion(xml: string): string | null {
    if (!xml) return null;
    const libs = [...xml.matchAll(/<Bibliothek>([\s\S]*?)<\/Bibliothek>/g)].map((m) => m[1]);
    const pick = libs.find((b) => /<Name>[^<]*ericapi/i.test(b)) ?? libs[0];
    const prod = pick?.match(/<Produktversion>\s*([\d.,\s]+?)\s*<\/Produktversion>/);
    if (prod) {
        const parts = prod[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (parts.length) return parts.join('.');
    }
    const num = xml.match(/\d+\.\d+\.\d+(?:\.\d+)?/);
    return num ? num[0] : null;
}
