/** id → name tables from Paperless (tags, correspondents), fetched once and shared by every row. */
export interface Named { id: number; name: string }

export function nameMap(items: Named[]): Map<number, string> {
    return new Map(items.map((i) => [i.id, i.name]));
}

/** Names for ids, in the document's order; an id the table does not know is shown as `#id`, never dropped. */
export function namesFor(ids: number[], names: Map<number, string>): string[] {
    return ids.map((id) => names.get(id) ?? `#${id}`);
}

/** Runs `load` once; a failure is not cached, so the next call retries. */
export function cachedOnce<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () => {
        pending ??= load().catch((e) => {
            pending = undefined;
            throw e;
        });
        return pending;
    };
}
