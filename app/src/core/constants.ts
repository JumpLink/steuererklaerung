/**
 * Centralized constants for the steuererklaerung-cli.
 * Each constant is documented with the reasoning behind its value.
 */

export const DEFAULTS = {
    /** Standard page size for paginated API requests (Paperless). */
    PAGE_SIZE: 100,

    /** Throttle between consecutive LLM / write operations to avoid rate limits (ms). */
    API_THROTTLE_MS: 1000,

    /** Tolerance when comparing EUR amounts between Qonto and invoice values (EUR). */
    AMOUNT_TOLERANCE_EUR: 0.01,

    /**
     * When matching Qonto attachments to Paperless documents by filename,
     * documents within this many days of the Qonto settlement date are considered.
     * Qonto settlements can lag the actual invoice date by up to ~2 weeks.
     */
    DATE_TOLERANCE_DAYS: 14,

    /** Max characters of HTTP response body included in error messages. */
    HTTP_ERROR_SNIPPET_LEN: 120,

    /** Max characters of OCR content sent to the LLM to avoid context overflow. */
    LLM_MAX_CONTENT_LENGTH: 100_000,
} as const;
