/** Bookkeeping only: no tax feature of any country. */

import type { TaxModule } from '../types.ts';

export const NONE_MODULE: TaxModule = {
    id: 'none',
    capabilities: {
        taxFiling: false,
        vatReturn: false,
        incomeTax: false,
        tradeTax: false,
        electronicFiling: false,
        taxAccount: false,
        taxForecast: false,
        taxDeadlines: false,
    },
};
