/**
 * Runtime-agnostic model for a "Steuererklärungs-Prüf-Datenblatt" PDF — a clean, human-readable
 * one-pager (or few) of a tax return's key figures, so the user can review them before uploading
 * the ERiC XML to Mein ELSTER. Generic on purpose: the same layout renders the Feststellung, the
 * Anlage EÜR, the USt-Jahreserklärung, the GewSt and a USt-VA. All values are pre-formatted display
 * strings (de-DE) — the GJS renderer (index.gjs.ts) stays pure drawing; the CLI builds the model.
 */

/** One label/value line inside a section. */
export interface SteuerblattRow {
    label: string;
    /** Pre-formatted value (e.g. "1.196,82 €"); '' draws a label-only sub-heading line. */
    value: string;
    /** 0 = flush left (default), 1 = indented sub-item. */
    indent?: number;
    /** Draw bold — for totals / the bottom-line result of a section. */
    emphasis?: boolean;
}

/** A titled group of rows (e.g. "Gesamthand", "Anlage EÜR — Kennzahlen"). */
export interface SteuerblattSection {
    heading: string;
    rows: SteuerblattRow[];
}

/** The complete review datasheet (A4, may paginate). */
export interface SteuerblattModel {
    /** e.g. "Feststellungserklärung 2025 — Prüf-Datenblatt". */
    title: string;
    /** One-line context under the title, e.g. "Gesonderte u. einheitliche Feststellung (GbR)". */
    subtitle: string;
    /** Header key/value block (Entität, Steuernummer, Zeitraum, …). */
    meta: { label: string; value: string }[];
    sections: SteuerblattSection[];
    /** Prominent caveats shown above the note (e.g. unklassifizierte Buchungen, Schätzungen). */
    warnings: string[];
    /** Closing methodology / source note, or null. */
    note: string | null;
}
