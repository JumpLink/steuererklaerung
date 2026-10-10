/**
 * Country registry (ADR 0001): resolves an entity's tax module and answers what it offers. Every
 * frontend gates tax features through {@link capabilities} and refuses tax-only work through
 * {@link requireTaxModule}; none of them reads `country`/`taxModule` directly.
 */

import { countryOf, taxModuleOf, type CountryFields, type TaxModuleId } from '../config/index.ts';
import { DE_MODULE } from './de/index.ts';
import { NONE_MODULE } from './none/index.ts';
import type { Capabilities, Capability, TaxModule } from './types.ts';

export type { Capabilities, Capability, TaxModule } from './types.ts';

/**
 * The ISO 3166-1 code stored for "another country" in the setup assistant and Settings. ZZ is
 * user-assigned ("unknown or unspecified"), so it never collides with a real country and resolves
 * to bookkeeping only until that country gets a module.
 */
export const OTHER_COUNTRY = 'ZZ';

const MODULES: Record<TaxModuleId, TaxModule> = { de: DE_MODULE, none: NONE_MODULE };

/** The module behind an id. */
export function taxModule(id: TaxModuleId): TaxModule {
    return MODULES[id];
}

/** What the entity's tax module offers; an entity without the fields gets the German module. */
export function capabilities(entity: CountryFields): Capabilities {
    return { ...MODULES[taxModuleOf(entity)].capabilities };
}

/** Whether any tax feature is on for the entity. */
export function hasTaxModule(entity: CountryFields): boolean {
    return taxModuleOf(entity) !== 'none';
}

/** Thrown when tax-only work is asked of an entity whose tax module is off. */
export class TaxModuleOffError extends Error {
    constructor(
        readonly entityId: string,
        readonly capability: Capability,
    ) {
        super(
            `Die deutschen Steuerfunktionen sind für die Entität „${entityId}" ausgeschaltet. ` +
                'Einschalten unter Einstellungen → Land & Steuern (oder im Manifest das Feld `taxModule` entfernen).',
        );
        this.name = 'TaxModuleOffError';
    }
}

/** Refuse unless the entity's module offers `capability` (default: tax filing at all). */
export function requireTaxModule(entity: CountryFields & { id: string }, capability: Capability = 'taxFiling'): void {
    if (!capabilities(entity)[capability]) throw new TaxModuleOffError(entity.id, capability);
}

export { countryOf, taxModuleOf };
