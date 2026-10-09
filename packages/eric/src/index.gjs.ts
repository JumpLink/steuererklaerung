/**
 * GJS implementation of the ERiC facade, backed by the native @steuererklaerung/eric
 * GObject-Introspection binding (`SteuerEric`, built from src/vala via meson
 * — see meson.build / prebuilds/). Buffer lifecycle lives in the Vala layer, so
 * here we only translate return codes into the same shapes the Node (koffi) build
 * produces.
 *
 * The ERiC shared library is USER-PROVIDED (ERIC_HOME) and never shipped. At
 * runtime, the package's prebuilds must be on GI_TYPELIB_PATH/LD_LIBRARY_PATH
 * (the gjsify CLI injects these automatically for installed native packages) and
 * `$ERIC_HOME/lib` must be on LD_LIBRARY_PATH so libericapi.so + its dependencies
 * resolve.
 *
 * Selected automatically via package.json `exports` (browser → here, node →
 * index.node.ts). Keep the exported surface identical to index.node.ts.
 */

// --- Runtime-agnostic re-exports (shared with the Node build) ---
export { isEricAvailable, getEricPaths, resolveEricHome, ERIC_NOT_FOUND_MESSAGE } from './paths.ts';
export type { EricPaths } from './paths.ts';
export { EricError, EricNotAvailableError } from './errors.ts';
export {
  EricFlags,
  EricErrorCodes,
  ERIC_TESTMERKER_CLEARINGSTELLE,
  ERIC_TESTMERKER_ECC,
  type EricValidationResult,
  type EricVorgangResult,
  type EricSendResult,
  type SendXmlOptions,
} from './types.ts';
export { hasTestmerker, parseTransferticket, assertSendAllowed, mapSendResult } from './send.ts';
export { runSetup, verifyInstallation, findJarFile } from './setup.ts';
export type { SetupVerification } from './setup.ts';

import { mkdirSync } from 'node:fs';
import { EricError, EricNotAvailableError } from './errors.ts';
import {
  EricErrorCodes,
  EricFlags,
  type EricSendResult,
  type EricValidationResult,
  type SendXmlOptions,
} from './types.ts';
import { assertSendAllowed, mapSendResult } from './send.ts';
import { getEricPaths, ERIC_NOT_FOUND_MESSAGE } from './paths.ts';

/** Shape of the native `SteuerEric.Eric` GObject (snake_case GIR methods). */
interface NativeEric {
  initialisiere(pluginPfad: string, logPfad: string): number;
  beende(): number;
  pruefe_steuernummer(stnr: string): number;
  pruefe_iban(iban: string): number;
  version(): string;
  /** [returnCode, errorText] */
  check_xml(xml: string, datenartVersion: string): [number, string];
  /** [returnCode, rueckgabeXml, serverantwortXml] */
  validate_vorgang(datenpuffer: string, datenartVersion: string, flags: number): [number, string, string];
  /** [returnCode, rueckgabeXml, serverantwortXml] */
  send_vorgang(
    datenpuffer: string,
    datenartVersion: string,
    flags: number,
    keystorePfad: string,
    pin: string,
  ): [number, string, string];
  fehler_text(fehlerkode: number): string;
}
interface NativeEricClass {
  new (): NativeEric;
}

let _instance: NativeEric | null = null;
let _initialized = false;

function load(): NativeEricClass {
  const gi = (globalThis as unknown as { imports?: { gi?: Record<string, { Eric?: NativeEricClass }> } }).imports?.gi;
  // GJS' legacy `imports.gi.<Namespace>` THROWS a GError ("Typelib file for namespace
  // '…' not found") when the typelib is absent — it does NOT return undefined. So the
  // property access must be guarded, or a missing/un-built binding crashes the process
  // with a cryptic GI error instead of our actionable EricNotAvailableError.
  let mod: { Eric?: NativeEricClass } | undefined;
  try {
    mod = gi?.SteuerEric;
  } catch {
    mod = undefined;
  }
  if (!mod?.Eric) {
    throw new EricNotAvailableError(
      'The native @steuererklaerung/eric binding (SteuerEric typelib) is not loadable. Build it with ' +
        '`npm run -w @steuererklaerung/eric build:meson`, ensure its prebuilds are on GI_TYPELIB_PATH/LD_LIBRARY_PATH, ' +
        'and put $ERIC_HOME/lib on LD_LIBRARY_PATH so libericapi.so resolves.\n\n' +
        ERIC_NOT_FOUND_MESSAGE,
    );
  }
  return mod.Eric;
}

function instance(): NativeEric {
  if (!_instance) _instance = new (load())();
  return _instance;
}

/** Initialize the ERiC library. Must be called before validation/version. */
export function initializeEric(): void {
  if (_initialized) return;
  const paths = getEricPaths();
  mkdirSync(paths.logs, { recursive: true });
  const rc = instance().initialisiere(paths.plugins, paths.logs);
  if (rc !== EricErrorCodes.ERIC_OK) {
    throw new EricError(rc, getErrorText(rc), 'EricInitialisiere');
  }
  _initialized = true;
}

/** Shut down the ERiC library. */
export function shutdownEric(): void {
  if (!_initialized || !_instance) return;
  _instance.beende();
  _initialized = false;
}

/** Human-readable message for an ERiC error code. */
export function getErrorText(errorCode: number): string {
  if (errorCode === EricErrorCodes.ERIC_OK) return 'OK';
  try {
    return instance().fehler_text(errorCode) || `Error code ${errorCode}`;
  } catch {
    return `Unknown error (code ${errorCode})`;
  }
}

/** ERiC version information as XML string. */
export function getVersion(): string {
  return instance().version();
}

/** Validate tax data XML using ERiC's plausibility checks. Initializes ERiC if needed. */
export function validateXml(xml: string, datenartVersion: string): EricValidationResult {
  initializeEric();
  const flags = EricFlags.VALIDIERE | EricFlags.PRUEFE_HINWEISE;
  const [rc, rawXml] = instance().validate_vorgang(xml, datenartVersion, flags);

  if (rc === EricErrorCodes.ERIC_OK) {
    return { valid: true, returnCode: rc, hinweise: '', fehler: '', rawXml };
  }
  if (rc === EricErrorCodes.ERIC_GLOBAL_HINWEISE) {
    return { valid: true, returnCode: rc, hinweise: rawXml, fehler: '', rawXml };
  }
  if (rc === EricErrorCodes.ERIC_GLOBAL_PRUEF_FEHLER) {
    return { valid: false, returnCode: rc, hinweise: '', fehler: rawXml, rawXml };
  }
  const errorText = getErrorText(rc);
  return { valid: false, returnCode: rc, hinweise: '', fehler: rawXml || errorText, rawXml };
}

/** Validate XML against the schema only (lighter than validateXml). */
export function checkXml(xml: string, datenartVersion: string): { valid: boolean; errors: string } {
  initializeEric();
  const [rc, errors] = instance().check_xml(xml, datenartVersion);
  if (rc === EricErrorCodes.ERIC_OK) return { valid: true, errors: '' };
  return { valid: false, errors: errors || getErrorText(rc) };
}

/**
 * Submit tax data XML to the ELSTER server (EricBearbeiteVorgang with the SENDE
 * flag), signed with the PKCS#12 keystore in `opts`. Whether the transmission
 * hits the live system or is discarded is governed by the `<Testmerker>` in the
 * XML; {@link assertSendAllowed} refuses a live send unless `opts.allowLive` is
 * set. Performs no retry. Initializes ERiC if needed.
 */
export function sendXml(
  xml: string,
  datenartVersion: string,
  opts: SendXmlOptions,
): EricSendResult {
  assertSendAllowed(xml, opts);
  initializeEric();
  const flags = EricFlags.VALIDIERE | EricFlags.SENDE;
  const [rc, rueckgabeXml, serverantwortXml] = instance().send_vorgang(
    xml,
    datenartVersion,
    flags,
    opts.keystorePath,
    opts.pin,
  );
  return mapSendResult(rc, rueckgabeXml, serverantwortXml, xml);
}

/** Check if a Steuernummer is formally valid. */
export function checkSteuernummer(steuernummer: string): boolean {
  initializeEric();
  return instance().pruefe_steuernummer(steuernummer) === EricErrorCodes.ERIC_OK;
}

/** Check if an IBAN is formally valid. */
export function checkIBAN(iban: string): boolean {
  initializeEric();
  return instance().pruefe_iban(iban) === EricErrorCodes.ERIC_OK;
}
