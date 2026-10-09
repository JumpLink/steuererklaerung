/**
 * ERiC library status probe — the read side of the in-app ELSTER submission feature (Phase 1).
 *
 * The ERiC native library is USER-PROVIDED (never shipped, see @steuererklaerung/eric README): the app
 * validates ELSTER XML against it, but the user installs it and points the app at it via
 * `config.eric_home` / the `ERIC_HOME` env var. This action reports, for a resolved home directory,
 * whether ERiC is available, its version, and (when incomplete) exactly what is missing — so a UI
 * can show the status and let the user set the path.
 *
 * Runtime-agnostic: the @steuererklaerung/eric facade is loaded via a dynamic import so the DESKTOP app
 * gets the GJS binding (index.gjs.ts) and the CLI/tests get the Node one (index.node.ts), exactly
 * like eric-cli.ts. A load failure of the native binding NEVER throws — it degrades to
 * `available:false` + `error`.
 */

/** Machine-readable ERiC availability snapshot for one resolved home directory. */
export interface EricStatus {
    /** ERiC is installed AND its native binding loaded (the version could be read). */
    available: boolean;
    /** ERiC product version (e.g. "43.4.6.0"), or null when unavailable/unreadable. */
    version: string | null;
    /** The resolved ERiC home directory that was probed (where the lib is expected). */
    ericHome: string;
    /** The resolved lib directory (`<ericHome>/lib`) — the expected libericapi.so location. */
    libPath: string;
    /** Required files missing from the runtime (empty when complete); see setup.ts REQUIRED_FILES. */
    missing: string[];
    /** Number of validation plugins (`*.so`) found under `<ericHome>/lib/plugins`. */
    pluginCount: number;
    /** Present only when the files exist but loading/initialising the native binding failed. */
    error?: string;
}

/**
 * Revive the (otherwise dead) `config.eric_home` field: when set, point `ERIC_HOME` at it so the
 * fs probes and the native init resolve the user's ERiC install. A no-op when unset (env / default
 * path stay authoritative). Call this wherever ERiC is about to be used from a loaded ELSTER config.
 */
export function applyEricHome(config: { eric_home?: string }): void {
    const home = config.eric_home?.trim();
    if (home) process.env.ERIC_HOME = home;
}

/**
 * Probe ERiC for a given home directory.
 *
 * Resolution: an explicit `ericHome` wins (and is written to `ERIC_HOME` so the eric package's
 * path helpers pick it up); otherwise the already-set `ERIC_HOME` env / `<cwd>/elster/runtime`
 * default is used. First does the pure-fs availability + verification probe; only if the files are
 * present does it try to actually load the binding and read the version — wrapped so a load failure
 * (unbuilt binding, missing LD_LIBRARY_PATH, arch mismatch) yields `available:false` + `error`
 * instead of throwing.
 */
export async function getEricStatus(ericHome?: string): Promise<EricStatus> {
    const explicit = ericHome?.trim();
    if (explicit) process.env.ERIC_HOME = explicit;

    const eric = await import('@steuererklaerung/eric');
    const paths = eric.getEricPaths();
    const verification = eric.verifyInstallation();

    const base: EricStatus = {
        available: false,
        version: null,
        ericHome: paths.home,
        libPath: paths.lib,
        missing: verification.missing,
        pluginCount: verification.pluginCount,
    };

    if (!eric.isEricAvailable()) return base;

    // Files are present — try to load the native binding and read the version. Any failure here is
    // reported (not thrown): the lib is on disk but not usable in this runtime/environment.
    try {
        eric.initializeEric();
        return { ...base, available: true, version: parseEricVersion(eric.getVersion()) };
    } catch (err) {
        return { ...base, available: false, error: err instanceof Error ? err.message : String(err) };
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
 * comma-separated `<Produktversion>` (e.g. "43, 4, 6, 0"); we prefer the core `ericapi` library and
 * render it dotted ("43.4.6.0"). Falls back to any dotted version token, else null.
 */
function parseEricVersion(xml: string): string | null {
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
