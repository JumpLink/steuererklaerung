/**
 * TypeScript types mirroring ERiC C API structs, enums, and constants.
 * Based on eric_types.h, eric_fehlercodes.h, and ericdef.h (Release 43.4.6.0).
 */

// ---------------------------------------------------------------------------
// Processing flags (eric_bearbeitung_flag_t)
// ---------------------------------------------------------------------------

export const EricFlags = {
  /** Validate the dataset. */
  VALIDIERE: 1 << 1,
  /** Send the dataset to the ELSTER server. */
  SENDE: 1 << 2,
  /** Print / generate PDF. */
  DRUCKE: 1 << 5,
  /** Check for informational hints. */
  PRUEFE_HINWEISE: 1 << 7,
  /** Validate without checking the release date. Cannot be combined with VALIDIERE or SENDE. */
  VALIDIERE_OHNE_FREIGABEDATUM: 1 << 8,
} as const;

// ---------------------------------------------------------------------------
// Struct parameter interfaces
// ---------------------------------------------------------------------------

/** Mirrors eric_druck_parameter_t. */
export interface EricDruckParameter {
  /** Must be 4. */
  version: number;
  /** 1 = preview PDF, 0 = final. */
  vorschau: number;
  /** 1 = duplex printing margin, 0 = simplex. */
  duplexDruck: number;
  /** Output PDF file path. */
  pdfName: string;
  /** Optional footer text (max 30 chars). */
  fussText: string | null;
}

/** Mirrors eric_verschluesselungs_parameter_t. */
export interface EricVerschluesselungsParameter {
  /** Must be 3. */
  version: number;
  /** Certificate handle (uint32). */
  zertifikatHandle: number;
  /** PIN for the certificate keystore. */
  pin: string;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface EricValidationResult {
  valid: boolean;
  returnCode: number;
  /** Hints returned by ERiC (ERIC_GLOBAL_HINWEISE). */
  hinweise: string;
  /** Errors returned by ERiC (ERIC_GLOBAL_PRUEF_FEHLER). */
  fehler: string;
  /** Raw XML from the rueckgabeXmlPuffer. */
  rawXml: string;
}

export interface EricVorgangResult {
  returnCode: number;
  /** XML from rueckgabeXmlPuffer (contains Telenummer on success). */
  rueckgabeXml: string;
  /** XML from serverantwortXmlPuffer. */
  serverantwortXml: string;
}

/** Options for {@link sendXml} — submitting a dataset to the ELSTER server. */
export interface SendXmlOptions {
  /** Absolute path to the PKCS#12 keystore (.pfx/.p12) used to sign the transfer. */
  keystorePath: string;
  /** PIN for the keystore. */
  pin: string;
  /**
   * Safety gate. An XML WITHOUT a `<Testmerker>` transmits to the LIVE ELSTER
   * system; that is refused unless `allowLive` is explicitly `true`. Test
   * transmissions (Testmerker present, e.g. 700000004) always proceed.
   */
  allowLive?: boolean;
}

/** Result of a {@link sendXml} submission. */
export interface EricSendResult {
  /** True only when ERiC accepted the transmission (ERIC_OK / ERIC_GLOBAL_HINWEISE). */
  ok: boolean;
  returnCode: number;
  /** Whether the transmitted XML carried a `<Testmerker>` (i.e. a test send). */
  testMode: boolean;
  /** Transferticket extracted from the server answer (empty when absent/failed). */
  transferticket: string;
  /** Full server-answer XML (serverantwortXmlPuffer). */
  serverantwortXml: string;
  /** Receipt XML (rueckgabeXmlPuffer; contains the Telenummer on success). */
  rueckgabeXml: string;
  /** Informational hints returned by ERiC, if any. */
  hinweise: string;
  /** Error text returned by ERiC, if any. */
  fehler: string;
}

// ---------------------------------------------------------------------------
// Constants from ericdef.h
// ---------------------------------------------------------------------------

/** Maximum footer text length. */
export const ERIC_MAX_LAENGE_FUSSTEXT = 30;

/** Test marker: cases are discarded at the clearing house (no processing). */
export const ERIC_TESTMERKER_CLEARINGSTELLE = '700000004';

/** Test marker: cases are discarded at the ECC (no processing). */
export const ERIC_TESTMERKER_ECC = '700000001';

// ---------------------------------------------------------------------------
// Key error codes from eric_fehlercodes.h
// ---------------------------------------------------------------------------

export const EricErrorCodes = {
  ERIC_OK: 0,
  ERIC_GLOBAL_UNKNOWN: 610001001,
  ERIC_GLOBAL_PRUEF_FEHLER: 610001002,
  ERIC_GLOBAL_HINWEISE: 610001003,
  ERIC_GLOBAL_NICHT_GENUEGEND_ARBEITSSPEICHER: 610001013,
  ERIC_GLOBAL_DATEI_NICHT_GEFUNDEN: 610001014,
  ERIC_GLOBAL_HERSTELLER_ID_NICHT_ERLAUBT: 610001016,
  ERIC_GLOBAL_NICHT_INITIALISIERT: 610001081,
  ERIC_GLOBAL_MEHRFACHE_INITIALISIERUNG: 610001082,
  ERIC_GLOBAL_FEHLER_INITIALISIERUNG: 610001083,
  ERIC_GLOBAL_STEUERNUMMER_UNGUELTIG: 610001034,
  ERIC_GLOBAL_DATENARTVERSION_UNBEKANNT: 610001042,
  ERIC_GLOBAL_COMMONDATA_NICHT_VERFUEGBAR: 610001045,
  ERIC_GLOBAL_UNGUELTIGER_PARAMETER: 610001222,
  ERIC_GLOBAL_NULL_PARAMETER: 610001526,
  ERIC_GLOBAL_IBAN_FORMALER_FEHLER: 610001501,
  ERIC_GLOBAL_IBAN_PRUEFZIFFER_FEHLER: 610001504,
  ERIC_TRANSFER_COM_ERROR: 610101200,
  ERIC_TRANSFER_ERR_XML_THEADER: 610101210,
  ERIC_TRANSFER_ERR_XML_NHEADER: 610101292,
  ERIC_TRANSFER_ERR_CONNECTSERVER: 610101278,
  ERIC_TRANSFER_ERR_TIMEOUT: 610101283,
  ERIC_CRYPT_E_PIN_WRONG: 610201106,
  ERIC_CRYPT_E_PIN_LOCKED: 610201107,
  ERIC_CRYPT_E_P12_READ: 610201111,
  ERIC_CRYPT_E_P12_DECODE: 610201112,
  ERIC_IO_PARSE_FEHLER: 610301006,
  ERIC_IO_READER_SCHEMA_VALIDIERUNGSFEHLER: 610301200,
} as const;
