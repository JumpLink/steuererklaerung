/**
 * Resolution of an entity's `country` + `taxModule` (both optional in the manifest). A missing
 * field means what every manifest written before the fields existed meant: Germany, with the
 * German tax module on. See docs/adr/0001-country-modules-and-per-entity-tax-switch.md.
 */

import type { TaxModuleId } from './schema/entity.ts';

/** The country an entity is taxed in when its manifest does not say. */
export const DEFAULT_COUNTRY = 'DE';

/** The minimal shape both accessors read — a manifest entity or a resolved one. */
export interface CountryFields {
    country?: string;
    taxModule?: TaxModuleId;
}

/** ISO 3166-1 alpha-2 country the entity is taxed in ('DE' when unset). */
export function countryOf(entity: CountryFields): string {
    return entity.country ?? DEFAULT_COUNTRY;
}

/** The country's own tax module; a country without one gets bookkeeping only. */
export function defaultTaxModuleFor(country: string): TaxModuleId {
    return country === 'DE' ? 'de' : 'none';
}

/** The tax module in effect: the explicit switch, else the country's own module. */
export function taxModuleOf(entity: CountryFields): TaxModuleId {
    return entity.taxModule ?? defaultTaxModuleFor(countryOf(entity));
}
