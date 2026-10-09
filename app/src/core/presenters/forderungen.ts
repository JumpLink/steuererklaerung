/**
 * Forderungen presenter — the Offene-Forderungen READ/DERIVE seam shared by the desktop view, the CLI
 * and the MCP tools: open items by age, per-customer payment behaviour, reminder state, Verjährung.
 * Plus the two reminder actions: drafting text (never sends) and the owner's „versandt" confirmation.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

export { entwerfeMahnung, loadForderungen, markiereMahnungVersandt } from '../actions/forderungen.ts';
export type { ForderungenUebersicht, MahnungEntwurfErgebnis } from '../actions/forderungen.ts';
export {
    ALTER_KLASSEN,
    MAHNUNG_ABSTAND_TAGE,
    MAHNUNG_FRIST_TAGE,
    VERJAEHRUNG_WARNFENSTER_TAGE,
    forderungenTitel,
    ueberfaellige,
} from '../invoices/forderungen.ts';
export type {
    AltersUebersicht,
    KundenVerhalten,
    Mahnstufe,
    OffenerPosten,
    Verjaehrung,
    ZahlungsTrend,
} from '../invoices/forderungen.ts';
export { MAHNSTUFEN, mahnstufeLabel } from '../invoices/mahnung-text.ts';
