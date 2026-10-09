import { describe, it, expect } from '@gjsify/unit';
import {
    taxRateLabelToNumber,
    normalizeTaxRateLabel,
    parseTaxRateValue,
    selectLabelToOptionId,
    selectOptionIdToLabel,
    getSelectFieldLabel,
    TAX_RATE_OPTIONS,
    canonicalSelectLabel,
    DATA_SCOPE_OPTIONS,
    ACCOUNTING_CATEGORY_OPTIONS,
} from '../../../src/core/lib/select-field-constants.ts';

// Characterization tests for the tax-rate + select-field-option helpers that map
// Paperless select values (stored as per-install option-id hashes) to/from labels
// and drive VAT handling in the EÜR/USt aggregation.

export default async () => {
    await describe('taxRateLabelToNumber', async () => {
        await it('parses percentage labels to numbers', async () => {
            expect(taxRateLabelToNumber('19%')).toBe(19);
            expect(taxRateLabelToNumber('7 %')).toBe(7);
            expect(taxRateLabelToNumber('0%')).toBe(0);
            expect(taxRateLabelToNumber('19')).toBe(19);
        });
        await it('returns null for non-numeric input', async () => {
            expect(taxRateLabelToNumber('abc')).toBeNull();
        });
    });

    await describe('normalizeTaxRateLabel', async () => {
        await it('canonicalises known rates and rejects unknown ones', async () => {
            expect(normalizeTaxRateLabel('19')).toBe('19%');
            expect(normalizeTaxRateLabel('19 %')).toBe('19%');
            expect(normalizeTaxRateLabel('16%')).toBe('16%');
            expect(normalizeTaxRateLabel('3')).toBeNull(); // not in TAX_RATE_OPTIONS
            expect(normalizeTaxRateLabel(undefined)).toBeNull();
        });
        await it('only emits options that exist', async () => {
            for (const label of TAX_RATE_OPTIONS) {
                expect(normalizeTaxRateLabel(label)).toBe(label);
            }
        });
    });

    await describe('parseTaxRateValue', async () => {
        await it('resolves a direct label without an option map', async () => {
            expect(parseTaxRateValue(undefined, '19%')).toBe(19);
            expect(parseTaxRateValue(undefined, '19')).toBe(19); // fallback parse
        });
        await it('resolves an option-id through the map', async () => {
            const map = { '19%': 'AbCd1234', '7%': 'Zz9988' };
            expect(parseTaxRateValue(map, 'AbCd1234')).toBe(19);
            expect(parseTaxRateValue(map, 'Zz9988')).toBe(7);
        });
        await it('returns null for null/garbage', async () => {
            expect(parseTaxRateValue(undefined, null)).toBeNull();
            expect(parseTaxRateValue(undefined, 'nope')).toBeNull();
        });
    });

    await describe('select option <-> label mapping', async () => {
        const map = { GOODS: 'opt-g', SERVICES: 'opt-s' };
        await it('maps label → option id and back', async () => {
            expect(selectLabelToOptionId(map, 'GOODS')).toBe('opt-g');
            expect(selectLabelToOptionId(map, 'MISSING')).toBeNull();
            expect(selectLabelToOptionId(undefined, 'GOODS')).toBeNull();
            expect(selectOptionIdToLabel(map, 'opt-s')).toBe('SERVICES');
            expect(selectOptionIdToLabel(map, 'opt-x')).toBeNull();
        });
        await it('getSelectFieldLabel accepts a raw label OR an option id', async () => {
            const valid = ['GOODS', 'SERVICES'] as const;
            expect(getSelectFieldLabel(valid, map, 'goods')).toBe('GOODS'); // case-insensitive label
            expect(getSelectFieldLabel(valid, map, 'opt-s')).toBe('SERVICES'); // via id
            expect(getSelectFieldLabel(valid, map, '')).toBeNull();
            expect(getSelectFieldLabel(valid, map, null)).toBeNull();
        });
    });

    /**
     * Eleven option labels carry a German umlaut and are typed by hand on the command line.
     * An exact comparison rejected `--data-scope geschaeftlich`, passed the raw string on, and
     * Paperless answered with an opaque "Value must be an id of an element in [{…}]" — nothing
     * in which says "you wrote ae instead of ä".
     */
    await describe('canonicalSelectLabel', async () => {
        await it('accepts the umlaut-free spelling of a label', async () => {
            expect(canonicalSelectLabel(DATA_SCOPE_OPTIONS, 'geschaeftlich')).toBe('geschäftlich');
            expect(canonicalSelectLabel(ACCOUNTING_CATEGORY_OPTIONS, '4930 Buerobedarf')).toBe('4930 Bürobedarf');
            expect(canonicalSelectLabel(ACCOUNTING_CATEGORY_OPTIONS, '8400 Erloese 19% USt')).toBe(
                '8400 Erlöse 19% USt',
            );
        });

        await it('returns the exact label unchanged — the common path stays untouched', async () => {
            expect(canonicalSelectLabel(DATA_SCOPE_OPTIONS, 'geschäftlich')).toBe('geschäftlich');
            expect(canonicalSelectLabel(DATA_SCOPE_OPTIONS, 'privat')).toBe('privat');
        });

        await it('ignores case and surrounding whitespace', async () => {
            expect(canonicalSelectLabel(DATA_SCOPE_OPTIONS, '  GESCHAEFTLICH ')).toBe('geschäftlich');
        });

        await it('still rejects a label that means nothing here', async () => {
            // The discriminator: tolerance must not turn into "accept anything".
            expect(canonicalSelectLabel(DATA_SCOPE_OPTIONS, 'betrieblich')).toBeUndefined();
            expect(canonicalSelectLabel(DATA_SCOPE_OPTIONS, '')).toBeUndefined();
        });

        await it('refuses an AMBIGUOUS folded match instead of picking one', async () => {
            // Guessing which category a booking belongs to is exactly the kind of silent decision
            // a tax figure must not rest on.
            expect(canonicalSelectLabel(['Grüße', 'Grüsse'], 'gruesse')).toBeUndefined();
            // …but an unambiguous one in the same shape still resolves.
            expect(canonicalSelectLabel(['Grüße'], 'gruesse')).toBe('Grüße');
        });
    });
};
