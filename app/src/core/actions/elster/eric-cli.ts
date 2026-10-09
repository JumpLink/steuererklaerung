/**
 * Shared ERiC CLI flow for the ELSTER declaration subcommands (UStVA, EÜR, UStE, GewSt,
 * Feststellung).
 *
 * Every `validate-eric` handler used to be a ~45-line copy of the same sequence: load the
 * ERiC binding, check availability, build the EDS XML (or read `--xml`), normalise the
 * encoding, validate, print the result. This collapses that to a per-form `buildXml` +
 * `datenartVersion`, and shares the `generate-xml` success tail.
 */

import { readFileSync } from 'node:fs';

import { resolveDefaultElster } from '../../config/index.ts';
import { applyEricHome } from './eric-status.ts';

/**
 * ERiC datenartVersion: a fixed token for the annual forms (`EUER_2025`, `USt_2025`, …) or a
 * function deriving it from the loaded XML (UStVA reads its schema year from the namespace).
 */
export type DatenartVersion = string | ((xml: string) => string);

/**
 * Run the `validate-eric` flow: load ERiC, build the EDS XML (or read `--xml`), normalise the
 * encoding, validate, print the outcome. Exits the process (0 = passed, 1 = failed/ERiC missing).
 *
 * The explicit `return` after each `process.exit` and the `if/else` around the outcome are
 * deliberate: on GJS `process.exit()` does not halt the current synchronous frame, so a
 * fall-through would keep running (and print both branches).
 */
export async function runEricValidateCommand(opts: {
    /** Path to an existing XML file; when set, skip generation and validate it as-is. */
    xmlPath?: string;
    /** Build the EDS XML from the aggregate when no `xmlPath` is given. */
    buildXml: () => Promise<string> | string;
    /** ERiC datenartVersion, or a function deriving it from the (loaded) XML. */
    datenartVersion: DatenartVersion;
}): Promise<void> {
    const { isEricAvailable, validateXml, ERIC_NOT_FOUND_MESSAGE, shutdownEric } =
        await import('@steuererklaerung/eric');
    // Revive `config.eric_home` BEFORE probing availability so a non-default ERiC install is found.
    // Best-effort: a pure `--xml` validation may run without a loadable ELSTER config.
    try {
        const elster = resolveDefaultElster();
        if (elster) applyEricHome(elster);
    } catch {
        /* no ELSTER config in scope — rely on ERIC_HOME env / the default runtime path */
    }
    if (!isEricAvailable()) {
        console.error(ERIC_NOT_FOUND_MESSAGE);
        process.exit(1);
        return;
    }

    let xml = opts.xmlPath ? readFileSync(opts.xmlPath, 'utf-8') : await opts.buildXml();
    const dv = typeof opts.datenartVersion === 'function' ? opts.datenartVersion(xml) : opts.datenartVersion;
    // ERiC requires UTF-8 without BOM — normalise the encoding declaration.
    xml = xml.replace(/encoding="[^"]*"/, 'encoding="UTF-8"');

    console.log(`Validating with ERiC (datenartVersion: ${dv})...`);
    const validation = validateXml(xml, dv);
    shutdownEric();

    if (validation.valid) {
        console.log('ERiC validation passed.');
        if (validation.hinweise) console.log(validation.hinweise);
        process.exit(0);
    } else {
        console.error('ERiC validation failed:');
        console.error(validation.fehler);
        process.exit(1);
    }
}

/** Print the shared `generate-xml` success tail (Wrote + how to validate + optional note). */
export function printGenerateXmlResult(form: string, file: string, year: number, note?: string): void {
    console.log(`Wrote ${file}`);
    console.log(`Validate: elster ${form} validate-eric --year ${year} --xml ${file}`);
    if (note) console.log(note);
}
