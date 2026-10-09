/**
 * Assistent data — the LLM Q&A over the entity-year aggregate, via the same `answer` the web uses.
 *
 * It needs the full per-(entity,year) YearCache (the same buildYearCache the web server prefetches),
 * so we build it once per entity-year and reuse it across questions. Heavy + OUTBOUND: the cache
 * build fetches Paperless, and `answer` runs the Claude Agent SDK (subprocess) with a single-shot
 * fallback. Failures (no model configured / SDK unsupported) propagate so the view can surface them.
 */

import { createAppContext } from '../../../core/context.ts';
import { buildYearCache, type YearCache } from '../../../core/presenters/year-snapshot.ts';
import { answer, type AssistantAnswer, type ChatTurn } from '../../../core/actions/assistant/chat.ts';
import { dmsProviderFor } from './dms.ts';
import type { AppEntity } from '../entities.ts';

// One YearCache per entity-year, built lazily and reused (dropped on failure so a retry rebuilds).
const cacheByKey = new Map<string, Promise<YearCache>>();

function yearCache(entity: AppEntity, year: number): Promise<YearCache> {
    const key = `${entity.id}:${year}`;
    let cached = cacheByKey.get(key);
    if (!cached) {
        const ctx = createAppContext();
        const elster = entity.elster;
        cached = buildYearCache(ctx.config, elster, year, entity.accountKeys, dmsProviderFor(entity)).catch((err) => {
            cacheByKey.delete(key);
            throw err;
        });
        cacheByKey.set(key, cached);
    }
    return cached;
}

/** Drop cached YearCaches — call when a write changes the underlying data (no write paths yet). */
export function clearYearCache(entityId?: string, year?: number): void {
    if (entityId == null) {
        cacheByKey.clear();
        return;
    }
    const exact = year != null ? `${entityId}:${year}` : null;
    const prefix = `${entityId}:`;
    for (const key of cacheByKey.keys()) {
        if (exact ? key === exact : key.startsWith(prefix)) cacheByKey.delete(key);
    }
}

/** Answer one question about the entity-year (builds/reuses the YearCache, then asks the model). */
export async function askAssistant(
    entity: AppEntity,
    year: number,
    question: string,
    history: ChatTurn[] = [],
): Promise<AssistantAnswer> {
    const yc = await yearCache(entity, year);
    return answer(question, yc, entity, year, history);
}
