/**
 * `@steuererklaerung/kredit` — loan mathematics for the financing planner.
 *
 * Objektfrei by design: nothing in here knows about a borrower, a property or an
 * account, so the package can move to a public repo unchanged if a second consumer
 * (e.g. the Bauplaner, which estimates the retrofit costs this credit pays for)
 * needs it.
 */

export { annuitaet, cent, maxDarlehen, restschuldNach, tilgungsplan } from './tilgungsplan.ts';
export { effektivzins, gesamtkosten } from './effektivzins.ts';
export { finanzierungsmix, mixRestschuldNach } from './mix.ts';
export type {
    DarlehenInput,
    EffektivzinsKosten,
    JahresZeile,
    TilgungsZeile,
    Tilgungsplan,
} from './types.ts';
export type {
    FinanzierungsmixInput,
    MixErgebnis,
    MixMonat,
    MixStufe,
    Tranche,
    TrancheErgebnis,
} from './mix.ts';
