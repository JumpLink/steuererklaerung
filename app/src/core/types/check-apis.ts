// ApiCheckResult now lives in @steuererklaerung/shared (shared by all REST clients); re-exported
// so existing `types/index.ts` consumers keep importing it from here unchanged.
export type { ApiCheckResult } from '@steuererklaerung/shared';

/** No CLI args for check-apis; config comes from env */
export interface CheckApisArgs {}
