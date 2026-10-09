/**
 * Utilities for building HTTP request bodies and query parameters.
 * Eliminates the ~66 occurrences of `if (params.x != null) body.x = params.x` pattern.
 */

/**
 * Build a request body from a params object by filtering out null/undefined values.
 * Optionally remap field names via a mapping object.
 *
 * @example
 * // Simple: key names match API fields
 * const body = buildBody({ name: 'Acme', description: null, page: 1 });
 * // → { name: 'Acme', page: 1 }
 *
 * @example
 * // With field remapping
 * const body = buildBody({ dateFrom: '2024-01-01' }, { dateFrom: 'date_from' });
 * // → { date_from: '2024-01-01' }
 */
export function buildBody<T extends Record<string, unknown>>(
  params: T,
  fieldMapping?: Partial<Record<keyof T, string>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const mappedKey = fieldMapping?.[key as keyof T] ?? key;
    body[mappedKey] = value;
  }
  return body;
}

/**
 * Build a URL query string from a params object.
 * Filters out null/undefined values. Handles arrays by repeating the key.
 *
 * @example
 * buildQueryString({ page: 1, tags: [1, 2], name: null });
 * // → "page=1&tags=1&tags=2"
 */
export function buildQueryString(params: Record<string, string | number | boolean | string[] | number[] | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}
