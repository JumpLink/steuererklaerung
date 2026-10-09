/**
 * The German tax module. It wires nothing yet: the German tax code still lives in
 * `core/elster/**` and moves here in steps 4–5 of ADR 0001. Today it only says what it offers.
 */

import type { TaxModule } from '../types.ts';

export const DE_MODULE: TaxModule = {
    id: 'de',
    capabilities: {
        taxFiling: true,
        vatReturn: true,
        incomeTax: true,
        tradeTax: true,
        electronicFiling: true,
        taxAccount: true,
        taxForecast: true,
        taxDeadlines: true,
    },
};
