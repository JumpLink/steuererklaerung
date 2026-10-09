/**
 * Resolve the Aussteller (issuer) identity for a self-generated invoice.
 *
 * The invoicing config (`invoicing.self.issuer` in steuererklaerung.json) is the authority; any field
 * it leaves blank falls back to the entity's ELSTER config (betrieb + tax_number), so a single
 * source of truth (the tax config) is reused and only invoice-specific fields — kleinunternehmer,
 * bank details, contact lines, logo — need to be set. Explicit issuer values always win, so
 * display formatting (e.g. the Steuernummer style) stays controllable. Pure + testable.
 */

import type { InvoiceIssuerSnapshot } from '@steuererklaerung/store';
import type { ElsterConfig } from '../config/index.ts';
import type { IssuerConfig } from '../config/index.ts';

/** The subset of the ELSTER config used as an issuer fallback. */
export interface IssuerFallback {
    name?: string | null;
    address?: string | null;
    zip?: string | null;
    city?: string | null;
    taxNumber?: string | null;
}

/** Extract the issuer fallback (name/address/tax number) from a loaded ELSTER config. */
export function elsterIssuerFallback(elster: ElsterConfig | undefined): IssuerFallback {
    if (!elster) return {};
    return {
        name: elster.betrieb?.name ?? null,
        address: elster.betrieb?.strasse ?? null,
        zip: elster.betrieb?.plz ?? null,
        city: elster.betrieb?.ort ?? null,
        taxNumber: elster.tax_number || null,
    };
}

const pick = (value: string | undefined | null, fallback: string | null | undefined): string | null =>
    value?.trim() ? value.trim() : (fallback ?? null);

/**
 * Merge the configured issuer over the ELSTER fallback into the snapshot the invoice freezes.
 * Only name/address/zip/city/taxNumber have a fallback; the rest come solely from the config.
 */
export function resolveInvoiceIssuer(
    issuer: IssuerConfig | null,
    fallback: IssuerFallback = {},
): InvoiceIssuerSnapshot {
    return {
        name: pick(issuer?.name, fallback.name) ?? '',
        address: pick(issuer?.address, fallback.address),
        zip: pick(issuer?.zip, fallback.zip),
        city: pick(issuer?.city, fallback.city),
        countryCode: issuer?.countryCode?.trim() || 'DE',
        email: issuer?.email?.trim() || null,
        phone: issuer?.phone?.trim() || null,
        website: issuer?.website?.trim() || null,
        taxNumber: pick(issuer?.taxNumber, fallback.taxNumber),
        vatId: issuer?.vatId?.trim() || null,
        kleinunternehmer: issuer?.kleinunternehmer ?? false,
        bank: issuer?.bank
            ? {
                  iban: issuer.bank.iban?.replace(/\s+/g, '') || null,
                  bic: issuer.bank.bic?.trim() || null,
                  bankName: issuer.bank.bankName?.trim() || null,
                  accountHolder: issuer.bank.accountHolder?.trim() || null,
              }
            : undefined,
    };
}
