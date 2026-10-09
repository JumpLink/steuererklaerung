/**
 * ELSTER Stammdaten (master data) — the header fields the annual web forms ask for, read straight
 * from the ElsterConfig so they never have to be `python3`'d out of the private config JSON by hand.
 *
 * Pure builder ({@link buildStammdaten}) over an {@link ElsterConfig} + the entity id, plus a thin
 * resolver ({@link elsterStammdaten}) that loads the entity's config via the workspace scope. Surfaces
 * name, Art (Tätigkeit), the Anschrift with street / Hausnummer / PLZ / Ort as SEPARATE fields,
 * Steuernummer (+ derived ELSTER 13-digit form + Bundesfinanzamtsnummer), USt-IdNr, W-IdNr, Rechtsform,
 * Einkunftsart, business_end_date and the Versteuerungsart (ist/soll).
 */

import type { ElsterConfig } from '../../config/index.ts';
import { bufaFromElsterSteuernummer, toElsterSteuernummer } from '../../elster/steuernummer.ts';
import { resolveEntityScope } from './snapshots.ts';

/** Anschrift with the street / Hausnummer / PLZ / Ort split into separate fields (as the forms want). */
export interface ElsterAnschrift {
    strasse: string | null;
    hausnummer: string | null;
    plz: string | null;
    ort: string | null;
}

/** The ELSTER master data for one entity, resolved from its config. */
export interface ElsterStammdaten {
    /** Workspace entity id (gbr|jumplink|privat). */
    entityId: string;
    /** Name des Unternehmens (betrieb.name). */
    name: string | null;
    /** Art des Betriebs / der Tätigkeit (betrieb.art) — the Schwerpunkt. */
    art: string | null;
    /** Anschrift, split into street / Hausnummer / PLZ / Ort. */
    anschrift: ElsterAnschrift;
    /** Steuernummer in the configured (regional) form. */
    steuernummer: string;
    /** Steuernummer in the 13-digit bundeseinheitliche ELSTER form (derived), or null if unconvertible. */
    steuernummerElster: string | null;
    /** Bundesfinanzamtsnummer (4-digit BUFA, derived from the Steuernummer), or null. */
    finanzamtBufa: string | null;
    /** Umsatzsteuer-Identifikationsnummer (DE + 9 digits), or null. */
    ustIdNr: string | null;
    /** Wirtschafts-Identifikationsnummer (DE + 9 digits + '-' + 5), or null — NOT the USt-IdNr. */
    wIdNr: string | null;
    /** Rechtsform code (E6000602), or null when unset (the forms default 270 = GbR). */
    rechtsform: string | null;
    /** Einkunftsart code (E6000603), or null when unset (the forms default 2 = Gewerbebetrieb). */
    einkunftsart: string | null;
    /** Letzter Tag der Unternehmereigenschaft (Betriebsaufgabe, YYYY-MM-DD), or null. */
    businessEndDate: string | null;
    /** Versteuerungsart: 'ist' (§20 UStG) oder 'soll'. */
    versteuerung: 'ist' | 'soll';
}

/** Split "Musterstraße 12" → { strasse, hausnummer }; the explicit `hausnummer` wins when present. */
function splitAnschrift(strasse: string, hausnummer?: string): { strasse: string; hausnummer: string | null } {
    if (hausnummer) return { strasse, hausnummer };
    const m = strasse.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
    return m ? { strasse: m[1], hausnummer: m[2].trim() } : { strasse, hausnummer: null };
}

/** Best-effort ELSTER Steuernummer conversion; returns null instead of throwing on an odd format. */
function tryElsterSteuernummer(regional: string): string | null {
    if (!regional) return null;
    try {
        return toElsterSteuernummer(regional);
    } catch {
        return null;
    }
}

/**
 * Build the {@link ElsterStammdaten} from a loaded config. Pure (no I/O) so it is unit-testable on a
 * fixture config; the resolver {@link elsterStammdaten} does the config loading.
 */
export function buildStammdaten(elster: ElsterConfig, entityId: string): ElsterStammdaten {
    const b = elster.betrieb;
    const anschrift: ElsterAnschrift = b
        ? { ...splitAnschrift(b.strasse, b.hausnummer), plz: b.plz, ort: b.ort }
        : { strasse: null, hausnummer: null, plz: null, ort: null };
    const steuernummerElster = tryElsterSteuernummer(elster.tax_number);

    return {
        entityId,
        name: b?.name ?? null,
        art: b?.art ?? null,
        anschrift,
        steuernummer: elster.tax_number,
        steuernummerElster,
        finanzamtBufa: steuernummerElster ? bufaFromElsterSteuernummer(steuernummerElster) : null,
        ustIdNr: b?.ust_idnr ?? null,
        wIdNr: b?.widnr ?? null,
        rechtsform: b?.rechtsform ?? null,
        einkunftsart: b?.einkunftsart ?? null,
        businessEndDate: elster.business_end_date ?? null,
        versteuerung: elster.taxation_basis,
    };
}

/**
 * Resolve a workspace entity id to its ELSTER master data — loads the entity's ELSTER config via the
 * shared scope resolver (throws on an unknown / config-less entity) and builds the {@link ElsterStammdaten}.
 */
export function elsterStammdaten(entityId: string): ElsterStammdaten {
    const scope = resolveEntityScope(entityId);
    if (!scope.elster) {
        throw new Error(`Entität '${entityId}' hat keine ELSTER-Config — keine Stammdaten verfügbar.`);
    }
    return buildStammdaten(scope.elster, entityId);
}

/** Print the master data as an aligned key/value block (CLI). */
export function printStammdaten(s: ElsterStammdaten): void {
    const versteuerung = s.versteuerung === 'ist' ? 'Ist-Versteuerung (§20 UStG)' : 'Soll-Versteuerung';
    const rows: Array<[string, string]> = [
        ['Entität', s.entityId],
        ['Name', s.name ?? '—'],
        ['Art (Tätigkeit)', s.art ?? '—'],
        ['Straße', s.anschrift.strasse ?? '—'],
        ['Hausnummer', s.anschrift.hausnummer ?? '—'],
        ['PLZ', s.anschrift.plz ?? '—'],
        ['Ort', s.anschrift.ort ?? '—'],
        ['Steuernummer', s.steuernummer || '—'],
        ['  ↳ ELSTER (13-stellig)', s.steuernummerElster ?? '—'],
        ['Finanzamt (BUFA-Nr.)', s.finanzamtBufa ?? '—'],
        ['USt-IdNr', s.ustIdNr ?? '—'],
        ['W-IdNr', s.wIdNr ?? '— (ggf. beim BZSt nachsehen — NICHT die USt-IdNr)'],
        ['Rechtsform', s.rechtsform ?? '— (Vorgabe 270 = GbR)'],
        ['Einkunftsart', s.einkunftsart ?? '— (Vorgabe 2 = Gewerbebetrieb)'],
        ['Betriebsaufgabe (Ende)', s.businessEndDate ?? '—'],
        ['Versteuerung', versteuerung],
    ];
    console.log(`\nELSTER-Stammdaten — ${s.entityId}`);
    console.log('='.repeat(60));
    for (const [k, v] of rows) console.log(`  ${k.padEnd(26)}${v}`);
    console.log('');
}
