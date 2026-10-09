/**
 * Finanzierung — Kapitalbedarf, Haushaltsrechnung, scenarios and the document checklist
 * for an Immobilien-/Sanierungsfinanzierung.
 *
 * Core-first: everything here is pure computation over the entity's inline
 * `finanzierung` config, so the CLI, the web UI and the native app share one
 * implementation. The loan arithmetic itself lives in `@steuererklaerung/kredit` (objektfrei —
 * it knows nothing about a borrower, a property or an account, so it can move to a public repo
 * unchanged); this layer is what binds it to the household's real figures.
 */

export { berechneBedarf } from './bedarf.ts';
export type { BedarfErgebnis, BedarfOverrides, NebenkostenErgebnis } from './bedarf.ts';

export { berechneHaushalt } from './haushalt.ts';
export type { HaushaltPosten, HaushaltsErgebnis } from './haushalt.ts';

export { berechneSzenarien } from './szenario.ts';
export type { SzenarioErgebnis, SzenarioOptions, SzenarioVariante } from './szenario.ts';

export { berechneUnterlagen } from './unterlagen.ts';
export type { UnterlagenErgebnis, UnterlagenKategorie, UnterlageStatus } from './unterlagen.ts';
