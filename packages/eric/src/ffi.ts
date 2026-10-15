/**
 * Low-level koffi FFI bindings for the ERiC C library.
 *
 * This is the only file that depends on koffi directly.
 * All ERiC function calls go through this module.
 *
 * On Linux x86_64, STDCALL is empty (= CDECL), which is koffi's default.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { getEricPaths, isEricAvailable, ERIC_NOT_FOUND_MESSAGE } from './paths.ts';
import { EricNotAvailableError } from './errors.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Opaque pointer: EricRueckgabepufferHandle = struct EricReturnBufferApi*
type EricRueckgabepufferHandle = unknown;

// ---------------------------------------------------------------------------
// koffi, loaded on first use
// ---------------------------------------------------------------------------

// koffi is a native addon with a prebuild per OS, and ERiC itself is only ever present on a Linux
// machine the user set up (see paths.ts). A static `import koffi` made the whole app bundle fail
// at start on macOS and Windows, where neither exists — and for a feature that is optional. So it
// is required when ERiC is first called, and a missing module reads as "ERiC not available".
type Koffi = typeof import('koffi');

let koffiModule: Koffi | null = null;

function loadKoffi(): Koffi {
  if (koffiModule) return koffiModule;
  let koffi: Koffi;
  try {
    koffi = createRequire(import.meta.url)('koffi') as Koffi;
  } catch {
    throw new EricNotAvailableError(ERIC_NOT_FOUND_MESSAGE);
  }
  // Types are registered once, by name, process-wide — a second registration throws.
  koffi.opaque('EricReturnBufferApi');

  // eric_druck_parameter_t struct
  koffi.struct('eric_druck_parameter_t', {
    version: 'uint32_t',
    vorschau: 'uint32_t',
    duplexDruck: 'uint32_t',
    pdfName: 'const char *',
    fussText: 'const char *',
    pdfCallback: 'void *', // function pointer — always null for now
    pdfCallbackBenutzerdaten: 'void *', // always null for now
  });

  // eric_verschluesselungs_parameter_t struct
  koffi.struct('eric_verschluesselungs_parameter_t', {
    version: 'uint32_t',
    zertifikatHandle: 'uint32_t',
    pin: 'const char *',
  });
  koffiModule = koffi;
  return koffi;
}

// ---------------------------------------------------------------------------
// Library state
// ---------------------------------------------------------------------------

interface EricLib {
  EricInitialisiere: (pluginPfad: string, logPfad: string) => number;
  EricBeende: () => number;
  EricBearbeiteVorgang: (
    datenpuffer: string,
    datenartVersion: string,
    bearbeitungsFlags: number,
    druckParameter: unknown,
    cryptoParameter: unknown,
    transferHandle: unknown,
    rueckgabeXmlPuffer: EricRueckgabepufferHandle,
    serverantwortXmlPuffer: EricRueckgabepufferHandle,
  ) => number;
  EricRueckgabepufferErzeugen: () => EricRueckgabepufferHandle;
  EricRueckgabepufferFreigeben: (handle: EricRueckgabepufferHandle) => number;
  EricRueckgabepufferInhalt: (handle: EricRueckgabepufferHandle) => string;
  EricRueckgabepufferLaenge: (handle: EricRueckgabepufferHandle) => number;
  EricHoleFehlerText: (fehlerkode: number, rueckgabePuffer: EricRueckgabepufferHandle) => number;
  EricPruefeSteuernummer: (steuernummer: string) => number;
  EricPruefeIBAN: (iban: string) => number;
  EricGetHandleToCertificate: (
    hToken: number[],
    iInfoPinSupport: number[],
    pathToKeystore: string,
  ) => number;
  EricCloseHandleToCertificate: (hToken: number) => number;
  EricCheckXML: (
    xml: string,
    datenartVersion: string,
    fehlertextPuffer: EricRueckgabepufferHandle,
  ) => number;
  EricVersion: (rueckgabeXmlPuffer: EricRueckgabepufferHandle) => number;
}

let lib: EricLib | null = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadLibrary(): EricLib {
  if (lib) return lib;

  if (!isEricAvailable()) {
    throw new EricNotAvailableError(ERIC_NOT_FOUND_MESSAGE);
  }

  const koffi = loadKoffi();
  const paths = getEricPaths();

  // Pre-load dependencies with RTLD_GLOBAL so libericapi.so can find them.
  // koffi.load uses dlopen with RTLD_LAZY | RTLD_GLOBAL by default on Linux.
  koffi.load(join(paths.lib, 'libericxerces.so'));
  koffi.load(join(paths.lib, 'libeSigner.so'));
  koffi.load(join(paths.lib, 'libotto.so'));

  const eric = koffi.load(join(paths.lib, 'libericapi.so'));

  lib = {
    EricInitialisiere: eric.func('int EricInitialisiere(const char *pluginPfad, const char *logPfad)'),

    EricBeende: eric.func('int EricBeende()'),

    EricBearbeiteVorgang: eric.func(
      `int EricBearbeiteVorgang(
        const char *datenpuffer,
        const char *datenartVersion,
        uint32_t bearbeitungsFlags,
        const eric_druck_parameter_t *druckParameter,
        const eric_verschluesselungs_parameter_t *cryptoParameter,
        _Out_ uint32_t *transferHandle,
        EricReturnBufferApi *rueckgabeXmlPuffer,
        EricReturnBufferApi *serverantwortXmlPuffer)`,
    ),

    EricRueckgabepufferErzeugen: eric.func(
      'EricReturnBufferApi *EricRueckgabepufferErzeugen()',
    ),

    EricRueckgabepufferFreigeben: eric.func(
      'int EricRueckgabepufferFreigeben(EricReturnBufferApi *handle)',
    ),

    EricRueckgabepufferInhalt: eric.func(
      'const char *EricRueckgabepufferInhalt(EricReturnBufferApi *handle)',
    ),

    EricRueckgabepufferLaenge: eric.func(
      'uint32_t EricRueckgabepufferLaenge(EricReturnBufferApi *handle)',
    ),

    EricHoleFehlerText: eric.func(
      'int EricHoleFehlerText(int fehlerkode, EricReturnBufferApi *rueckgabePuffer)',
    ),

    EricPruefeSteuernummer: eric.func('int EricPruefeSteuernummer(const char *steuernummer)'),

    EricPruefeIBAN: eric.func('int EricPruefeIBAN(const char *iban)'),

    EricGetHandleToCertificate: eric.func(
      'int EricGetHandleToCertificate(_Out_ uint32_t *hToken, _Out_ uint32_t *iInfoPinSupport, const char *pathToKeystore)',
    ),

    EricCloseHandleToCertificate: eric.func(
      'int EricCloseHandleToCertificate(uint32_t hToken)',
    ),

    EricCheckXML: eric.func(
      'int EricCheckXML(const char *xml, const char *datenartVersion, EricReturnBufferApi *fehlertextPuffer)',
    ),

    EricVersion: eric.func(
      'int EricVersion(EricReturnBufferApi *rueckgabeXmlPuffer)',
    ),
  };

  return lib;
}

// ---------------------------------------------------------------------------
// Public FFI functions
// ---------------------------------------------------------------------------

export function ericInitialisiere(pluginPfad: string, logPfad: string): number {
  mkdirSync(logPfad, { recursive: true });
  return loadLibrary().EricInitialisiere(pluginPfad, logPfad);
}

export function ericBeende(): number {
  return loadLibrary().EricBeende();
}

export function ericBearbeiteVorgang(
  datenpuffer: string,
  datenartVersion: string,
  bearbeitungsFlags: number,
  druckParameter: unknown,
  cryptoParameter: unknown,
  transferHandle: unknown,
  rueckgabeXmlPuffer: EricRueckgabepufferHandle,
  serverantwortXmlPuffer: EricRueckgabepufferHandle,
): number {
  return loadLibrary().EricBearbeiteVorgang(
    datenpuffer,
    datenartVersion,
    bearbeitungsFlags,
    druckParameter,
    cryptoParameter,
    transferHandle,
    rueckgabeXmlPuffer,
    serverantwortXmlPuffer,
  );
}

export function ericRueckgabepufferErzeugen(): EricRueckgabepufferHandle {
  return loadLibrary().EricRueckgabepufferErzeugen();
}

export function ericRueckgabepufferFreigeben(handle: EricRueckgabepufferHandle): number {
  return loadLibrary().EricRueckgabepufferFreigeben(handle);
}

export function ericRueckgabepufferInhalt(handle: EricRueckgabepufferHandle): string {
  return loadLibrary().EricRueckgabepufferInhalt(handle);
}

export function ericRueckgabepufferLaenge(handle: EricRueckgabepufferHandle): number {
  return loadLibrary().EricRueckgabepufferLaenge(handle);
}

export function ericHoleFehlerText(fehlerkode: number, rueckgabePuffer: EricRueckgabepufferHandle): number {
  return loadLibrary().EricHoleFehlerText(fehlerkode, rueckgabePuffer);
}

export function ericPruefeSteuernummer(steuernummer: string): number {
  return loadLibrary().EricPruefeSteuernummer(steuernummer);
}

export function ericPruefeIBAN(iban: string): number {
  return loadLibrary().EricPruefeIBAN(iban);
}

export function ericGetHandleToCertificate(
  hToken: number[],
  iInfoPinSupport: number[],
  pathToKeystore: string,
): number {
  return loadLibrary().EricGetHandleToCertificate(hToken, iInfoPinSupport, pathToKeystore);
}

export function ericCloseHandleToCertificate(hToken: number): number {
  return loadLibrary().EricCloseHandleToCertificate(hToken);
}

export function ericCheckXML(
  xml: string,
  datenartVersion: string,
  fehlertextPuffer: EricRueckgabepufferHandle,
): number {
  return loadLibrary().EricCheckXML(xml, datenartVersion, fehlertextPuffer);
}

export function ericVersion(rueckgabeXmlPuffer: EricRueckgabepufferHandle): number {
  return loadLibrary().EricVersion(rueckgabeXmlPuffer);
}
