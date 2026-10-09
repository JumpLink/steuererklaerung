/** Result of a single API connectivity check (shared by the REST-client `check()` helpers). */
export interface ApiCheckResult {
    name: string;
    ok: boolean;
    message?: string;
}
