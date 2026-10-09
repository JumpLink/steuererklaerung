/**
 * The seam between the bookkeeping core and a country's tax law (ADR 0001). A frontend never asks
 * "is this a German entity?"; it asks a capability, so a second country module only has to answer
 * the same questions.
 */

import type { TaxModuleId } from '../config/index.ts';

/**
 * What an entity's tax module offers. Bookkeeping — transactions, categorisation, receipts,
 * invoices, projects, contacts, time, reports, accounts — is NOT listed: it works for every entity,
 * whichever module is on.
 */
export interface Capabilities {
    /** Annual returns at all: the Tax nav entry and its hub (EÜR, Anlagen, Steuererklärung). */
    taxFiling: boolean;
    /** Periodic and annual VAT returns (USt-VA, USt-Erklärung). */
    vatReturn: boolean;
    /** Private income tax (Einkommensteuer) for a household entity. */
    incomeTax: boolean;
    /** Trade tax (Gewerbesteuer). */
    tradeTax: boolean;
    /** Electronic filing with the tax authority (ELSTER / ERiC). */
    electronicFiling: boolean;
    /** The tax account at the authority (Steuerkonto, Kontoabfrage). */
    taxAccount: boolean;
    /** Tax forecast and the tax reserve on the dashboard and in "frei verfügbar". */
    taxForecast: boolean;
    /** Statutory filing and payment deadlines. */
    taxDeadlines: boolean;
}

export type Capability = keyof Capabilities;

/** One tax module: an id and the capabilities it switches on. Data hooks follow in step 5. */
export interface TaxModule {
    id: TaxModuleId;
    capabilities: Capabilities;
}
