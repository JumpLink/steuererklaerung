/**
 * Parser for the ELSTER „Übertragungsprotokoll" (the PDF Mein ELSTER offers after a submission),
 * working on the text `pdftotext -layout` produces. Pure, so it is testable without a PDF.
 *
 * Two value layouts exist: annual forms list `Zeile`-numbered rows (the same Zeile can repeat, one
 * per Beteiligter — hence a list, not a map); the USt-VA lists rows that end in `<Kz> <Betrag> €`.
 */

export type ProtokollKind =
  | "ust-jahr"
  | "ustva"
  | "gewst"
  | "feststellung"
  | "dauerfrist"
  | "est"
  | "euer";

export interface ProtokollZeile {
  zeile: number;
  label: string;
  /** Amounts as numbers, dates and anything else as the original string. */
  values: (number | string)[];
}

export interface ProtokollKennzahl {
  kz: number;
  label: string;
  value: number;
}

export interface Uebertragungsprotokoll {
  kind: ProtokollKind;
  /** Register period: '2025', '2025-Q4' or '2025-03'. */
  period: string;
  steuernummer: string;
  transferticket: string;
  /** Eingang auf Server, local date + time as printed. */
  eingangDate: string;
  eingangTime: string;
  berichtigt: boolean;
  zeilen: ProtokollZeile[];
  kennzahlen: ProtokollKennzahl[];
}

const AMOUNT = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;
const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
const MONTHS = [
  "januar",
  "februar",
  "märz",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "dezember",
];
const QUARTERS: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };

/** German number format (1.234,56; leading minus) → number; null when the text is not an amount. */
export function parseGermanNumber(text: string): number | null {
  const t = text.trim();
  if (!AMOUNT.test(t)) return null;
  return Number(t.replace(/\./g, "").replace(",", "."));
}

function germanDateToIso(d: string): string {
  const [dd, mm, yyyy] = d.split(".");
  return `${yyyy}-${mm}-${dd}`;
}

/** The register date (YYYY-MM-DD) of a protocol's Eingang. */
export function eingangIsoDate(p: Uebertragungsprotokoll): string {
  return germanDateToIso(p.eingangDate);
}

/** Sortable Eingang timestamp ('YYYY-MM-DDTHH:MM:SS'). */
export function eingangSortKey(p: Uebertragungsprotokoll): string {
  return `${eingangIsoDate(p)}T${p.eingangTime}`;
}

function detectKind(text: string): ProtokollKind {
  // Dauerfrist first: the UStDV protocol may carry the title "Umsatzsteuer-Voranmeldung". Match
  // only the section heading at line start — the USt-Jahr's Zeile 119 mentions
  // "Sondervorauszahlung" too and must stay ust-jahr.
  if (
    /^\s*(?:I\.\s*)?Antrag auf Dauerfristverl[äa]ngerung|^\s*Anmeldung der Sondervorauszahlung/m.test(
      text,
    )
  )
    return "dauerfrist";
  if (/Umsatzsteuer-Voranmeldung(?!en)/.test(text)) return "ustva";
  if (/Erklärung zur gesonderten und einheitlichen Feststellung/.test(text))
    return "feststellung";
  if (/Gewerbesteuererklärung/.test(text)) return "gewst";
  if (/Umsatzsteuererklärung/.test(text)) return "ust-jahr";
  if (/Einkommensteuererklärung/.test(text)) return "est";
  if (/Anlage\s+E[ÜU]R|Einnahmen[üu]berschussrechnung/.test(text))
    return "euer";
  throw new Error("Unbekanntes Formular im Übertragungsprotokoll.");
}

function detectPeriod(text: string, kind: ProtokollKind): string {
  const year =
    text.match(/^\s*Kalenderjahr\s+(\d{4})/m)?.[1] ??
    text.match(/^\s*Jahr\s+(\d{4})/m)?.[1] ??
    // The Feststellung title wraps: "… Feststellung von\nGrundlagen für die Einkommensbesteuerung 2025".
    text.match(/^\s*Grundlagen für die \S+ (20\d{2})\b/m)?.[1] ??
    text.match(
      /(?:erklärung|Voranmeldung|Feststellung(?: von)?)[^\n]*?\b(20\d{2})\b/,
    )?.[1];
  if (!year)
    throw new Error(
      "Kein Veranlagungszeitraum im Übertragungsprotokoll gefunden.",
    );
  if (kind !== "ustva") return year;
  const q = text.match(/\b(IV|III|II|I)\.\s*Kalendervierteljahr/);
  if (q) return `${year}-Q${QUARTERS[q[1]]}`;
  const zeitraum = text.match(/^\s*Zeitraum\s+(\S+)/m)?.[1]?.toLowerCase();
  const month = zeitraum ? MONTHS.indexOf(zeitraum) : -1;
  if (month >= 0) return `${year}-${String(month + 1).padStart(2, "0")}`;
  throw new Error(
    "Kein Voranmeldungszeitraum im Übertragungsprotokoll gefunden.",
  );
}

function parseZeilen(text: string): ProtokollZeile[] {
  const out: ProtokollZeile[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d{1,3})\s+(\S.*?)\s*$/);
    if (!m) continue;
    const parts = m[2].split(/\s{2,}/);
    const values: (number | string)[] = [];
    // Columns separated by 2+ spaces: trailing numeric/date columns are values (BMG, amount).
    while (parts.length > 1) {
      const v = parts[parts.length - 1];
      if (parseGermanNumber(v) == null && !DATE.test(v)) break;
      values.unshift(parseGermanNumber(v) ?? v);
      parts.pop();
    }
    // Single-spaced: the last token is the value if it is unambiguously one.
    if (values.length === 0) {
      const tokens = parts[0].split(" ");
      const last = tokens[tokens.length - 1];
      const num = parseGermanNumber(last);
      if (
        tokens.length > 1 &&
        (DATE.test(last) || (num != null && /[,.-]/.test(last)))
      ) {
        values.push(num ?? last);
        parts[0] = tokens.slice(0, -1).join(" ");
      }
    }
    out.push({ zeile: Number(m[1]), label: parts.join(" ").trim(), values });
  }
  return out;
}

function parseKennzahlen(text: string): ProtokollKennzahl[] {
  const out: ProtokollKennzahl[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(
      /^(.*?)\s+(\d{2,3})\s+(-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?)\s*€\s*$/,
    );
    if (!m) continue;
    out.push({
      kz: Number(m[2]),
      label: m[1].trim(),
      value: parseGermanNumber(m[3]) as number,
    });
  }
  return out;
}

/** Parse the `pdftotext -layout` text of one Übertragungsprotokoll. Throws on an unknown form. */
export function parseUebertragungsprotokoll(
  text: string,
): Uebertragungsprotokoll {
  const eingang = text.match(
    /Eingang auf Server:\s*(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2}:\d{2})/,
  );
  if (!eingang)
    throw new Error('„Eingang auf Server" fehlt im Übertragungsprotokoll.');
  const steuernummer = text.match(/Steuernummer:\s*(\S+)/)?.[1];
  if (!steuernummer)
    throw new Error('„Steuernummer" fehlt im Übertragungsprotokoll.');
  const transferticket = text.match(/Transferticket:\s*(\S+)/)?.[1];
  if (!transferticket)
    throw new Error('„Transferticket" fehlt im Übertragungsprotokoll.');
  const kind = detectKind(text);
  return {
    kind,
    period: detectPeriod(text, kind),
    steuernummer,
    transferticket,
    eingangDate: eingang[1],
    eingangTime: eingang[2],
    berichtigt: /Berichtigte\s+(?:Steuer)?[Ee]rklärung/.test(text),
    zeilen: kind === "ustva" || kind === "dauerfrist" ? [] : parseZeilen(text),
    kennzahlen:
      kind === "ustva" || kind === "dauerfrist" ? parseKennzahlen(text) : [],
  };
}

/** The declared amount the register stores: USt-VA Kz 83, USt-Jahr Zeile 118; none otherwise. */
export function declaredAmountOf(
  p: Uebertragungsprotokoll,
): number | undefined {
  if (p.kind === "ustva") return p.kennzahlen.find((k) => k.kz === 83)?.value;
  if (p.kind === "ust-jahr") {
    const v = p.zeilen.find((z) => z.zeile === 118)?.values.at(-1);
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}
