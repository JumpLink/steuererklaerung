/**
 * Unterlagen — the lender's document checklist, with what is already on file.
 *
 * Why this belongs in the tool rather than in a note: a financing stalls on the one
 * document nobody tracked, and the documents themselves are already in Paperless. The
 * checklist below is the standard set for a Baufinanzierung; a configured entry with a
 * `paperless_id` counts as on file, so the gap is computed instead of remembered.
 *
 * The default list is a STARTING POINT, not a promise — every lender asks for its own
 * mix. Entries configured under `finanzierung.unterlagen` win over the defaults with
 * the same name, so the list converges on what your bank actually wants.
 */

import type { FinanzierungConfig, FinanzierungUnterlage } from '../../config/schema/finanzierung.ts';

/** One checklist entry, resolved against the configured state. */
export interface UnterlageStatus {
    bezeichnung: string;
    status: FinanzierungUnterlage['status'];
    paperlessId?: number;
    notiz?: string;
    /** Which category it belongs to, for grouped output. */
    kategorie: UnterlagenKategorie;
    /** True when the entry came from the default list, not from the config. */
    standard: boolean;
}

export type UnterlagenKategorie = 'person' | 'einkommen' | 'objekt' | 'vorhaben';

/** The checklist plus its summary counts. */
export interface UnterlagenErgebnis {
    eintraege: UnterlageStatus[];
    /** Count per status, for a one-line summary. */
    zusammenfassung: Record<FinanzierungUnterlage['status'], number>;
    /** Entries that are neither `vorhanden` nor `eingereicht`. */
    offen: UnterlageStatus[];
}

/**
 * The standard document set for a German Baufinanzierung.
 *
 * Grouped the way a lender's own checklist is: who you are, what you earn, what the
 * property is, and what you intend to do with it.
 */
const STANDARD_UNTERLAGEN: ReadonlyArray<{ bezeichnung: string; kategorie: UnterlagenKategorie }> = [
    { bezeichnung: 'Personalausweis (Vorder- und Rückseite)', kategorie: 'person' },
    { bezeichnung: 'SCHUFA-Selbstauskunft', kategorie: 'person' },
    { bezeichnung: 'Selbstauskunft der Bank (Formular)', kategorie: 'person' },

    { bezeichnung: 'Arbeitsvertrag', kategorie: 'einkommen' },
    { bezeichnung: 'Nachweis unbefristetes Arbeitsverhältnis / Probezeit beendet', kategorie: 'einkommen' },
    { bezeichnung: 'Gehaltsabrechnungen (letzte 3 Monate)', kategorie: 'einkommen' },
    { bezeichnung: 'Einkommensteuerbescheide (letzte 2 Jahre)', kategorie: 'einkommen' },
    { bezeichnung: 'Kontoauszüge (letzte 3 Monate)', kategorie: 'einkommen' },
    { bezeichnung: 'Nachweis Eigenkapital', kategorie: 'einkommen' },

    { bezeichnung: 'Grundbuchauszug', kategorie: 'objekt' },
    { bezeichnung: 'Flurkarte / Lageplan', kategorie: 'objekt' },
    { bezeichnung: 'Wohnflächenberechnung', kategorie: 'objekt' },
    { bezeichnung: 'Bauzeichnungen / Grundrisse', kategorie: 'objekt' },
    { bezeichnung: 'Objektfotos (innen und außen)', kategorie: 'objekt' },
    { bezeichnung: 'Energieausweis oder iSFP', kategorie: 'objekt' },

    { bezeichnung: 'Kaufvertragsentwurf (Notar)', kategorie: 'vorhaben' },
    { bezeichnung: 'Bestehender Darlehensvertrag (Ablösung)', kategorie: 'vorhaben' },
    { bezeichnung: 'Ablösevaluta / Restschuldbescheinigung der Bank', kategorie: 'vorhaben' },
    { bezeichnung: 'Kostenaufstellung Sanierung', kategorie: 'vorhaben' },
    { bezeichnung: 'Handwerker-Angebote (soweit vorhanden)', kategorie: 'vorhaben' },
];

/** Normalise a label so a configured entry matches its default counterpart. */
function key(bezeichnung: string): string {
    return bezeichnung.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
}

/**
 * Resolve the checklist: the standard set, overridden by anything configured, plus any
 * configured entry the standard set does not know about.
 *
 * @param cfg The entity's whole `finanzierung` block.
 * @returns The resolved checklist; see {@link UnterlagenErgebnis}.
 */
export function berechneUnterlagen(cfg: FinanzierungConfig): UnterlagenErgebnis {
    const konfiguriert = new Map(cfg.unterlagen.map((u) => [key(u.bezeichnung), u]));
    const eintraege: UnterlageStatus[] = [];

    for (const std of STANDARD_UNTERLAGEN) {
        const k = key(std.bezeichnung);
        const cfgEntry = konfiguriert.get(k);
        konfiguriert.delete(k);
        eintraege.push({
            bezeichnung: cfgEntry?.bezeichnung ?? std.bezeichnung,
            status: cfgEntry?.status ?? 'offen',
            paperlessId: cfgEntry?.paperless_id,
            notiz: cfgEntry?.notiz,
            kategorie: std.kategorie,
            standard: cfgEntry === undefined,
        });
    }

    // Anything the bank asked for that is not in the standard set.
    for (const rest of konfiguriert.values()) {
        eintraege.push({
            bezeichnung: rest.bezeichnung,
            status: rest.status,
            paperlessId: rest.paperless_id,
            notiz: rest.notiz,
            kategorie: 'vorhaben',
            standard: false,
        });
    }

    const zusammenfassung: Record<FinanzierungUnterlage['status'], number> = {
        offen: 0,
        angefordert: 0,
        vorhanden: 0,
        eingereicht: 0,
    };
    for (const e of eintraege) zusammenfassung[e.status] += 1;

    return {
        eintraege,
        zusammenfassung,
        offen: eintraege.filter((e) => e.status === 'offen' || e.status === 'angefordert'),
    };
}
