/**
 * Generic pagination helper for Paperless-style APIs that use { results, next } responses.
 * Eliminates 7+ duplicated pagination loops throughout the codebase.
 */

/** Minimal paginated response shape (Paperless-NGX style). */
export interface PaginatedResponse<T> {
  results: T[];
  next: string | null;
  count?: number;
}

/**
 * Fetch all pages from a paginated API endpoint.
 *
 * @param fetcher - Function that takes (page, pageSize) and returns a paginated response.
 * @param pageSize - Number of items per page (default 100).
 * @returns All results concatenated across all pages.
 *
 * @example
 * const allDocs = await fetchAllPages((page, pageSize) =>
 *   listDocuments({ page, page_size: pageSize })
 * );
 */
export async function fetchAllPages<T>(
  fetcher: (page: number, pageSize: number) => Promise<PaginatedResponse<T>>,
  pageSize = 100,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await fetcher(page, pageSize);
    const results = res.results ?? [];
    all.push(...results);
    hasMore = res.next != null && res.next !== '';
    page += 1;
  }

  return all;
}

/**
 * Fetch ALL pages, but concurrently: read page 1 to learn the total `count`, then fetch the
 * remaining pages with a bounded worker pool instead of one-at-a-time. For a slow/remote Paperless
 * this turns N serial round-trips into ~2 (page 1, then a parallel batch), the dominant win for the
 * web/app first-load. Falls back to serial `next`-following when the response carries no `count`.
 *
 * Order is preserved (pages reassembled by page number). Callers that need de-duplication (a document
 * added mid-fetch can shift pagination) should dedupe by id — the result may in rare cases repeat one.
 */
export async function fetchAllPagesParallel<T>(
  fetcher: (page: number, pageSize: number) => Promise<PaginatedResponse<T>>,
  opts: { pageSize?: number; concurrency?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const first = await fetcher(1, pageSize);
  const firstResults = first.results ?? [];

  // No count → we can't compute the page span up front; follow `next` serially (old behaviour).
  if (first.count == null) {
    const all = [...firstResults];
    let page = 2;
    let hasMore = first.next != null && first.next !== '' && firstResults.length >= pageSize;
    while (hasMore) {
      const res = await fetcher(page, pageSize);
      const r = res.results ?? [];
      all.push(...r);
      hasMore = res.next != null && res.next !== '' && r.length >= pageSize;
      page += 1;
    }
    return all;
  }

  const totalPages = Math.max(1, Math.ceil(first.count / pageSize));
  if (totalPages === 1) return firstResults;

  // Fetch pages 2..totalPages with a bounded worker pool; slot results by page index to keep order.
  const byPage: T[][] = new Array(totalPages + 1);
  byPage[1] = firstResults;
  let next = 2;
  const worker = async (): Promise<void> => {
    while (true) {
      const page = next++;
      if (page > totalPages) return;
      const res = await fetcher(page, pageSize);
      byPage[page] = res.results ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, totalPages - 1) }, worker));
  return byPage.flatMap((p) => p ?? []);
}

/**
 * Fetch pages until a limit is reached, applying an optional filter predicate.
 * Useful when you need to collect filtered items up to a max count.
 *
 * @param fetcher - Function that takes (page, pageSize) and returns a paginated response.
 * @param predicate - Optional filter applied to each item; only matching items are collected.
 * @param limit - Max number of matching items to collect (default: Infinity).
 * @param pageSize - Number of items per page (default 100).
 * @returns Collected items (up to limit).
 */
export async function fetchPagesUntil<T>(
  fetcher: (page: number, pageSize: number) => Promise<PaginatedResponse<T>>,
  predicate?: (item: T) => boolean,
  limit = Infinity,
  pageSize = 100,
): Promise<T[]> {
  const collected: T[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && collected.length < limit) {
    const res = await fetcher(page, pageSize);
    const results = res.results ?? [];

    for (const item of results) {
      if (collected.length >= limit) break;
      if (!predicate || predicate(item)) {
        collected.push(item);
      }
    }

    hasMore = res.next != null && res.next !== '' && results.length >= pageSize;
    page += 1;
  }

  return collected;
}
