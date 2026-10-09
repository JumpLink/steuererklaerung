/**
 * The sync service: runs the planned sources one after another, never twice at once, and keeps the
 * status the headerbar button shows. Frontend-free — the clock, the runners and the settings are
 * injected, so the scheduler is tested with a fake clock and the runners with a fake fetch.
 */

import {
    applicableSources,
    dueSources,
    prioritize,
    type SourceHistory,
    type SyncEntityInfo,
    type SyncSchedule,
    type SyncSource,
} from './plan.ts';

export interface RunnerResult {
    /** New or changed data — the open view should reload. */
    changed: boolean;
}

/** One source's work. Throws on failure; the service records it and carries on with the next. */
export type SyncRunner = (entity: SyncEntityInfo) => Promise<RunnerResult>;

export type SyncTrigger = 'manual' | 'auto';

export interface SyncRequest {
    entity: SyncEntityInfo;
    /** The open view's id; decides which source goes first. */
    view?: string;
    trigger: SyncTrigger;
}

export interface SyncFailure {
    source: SyncSource;
    message: string;
    at: number;
}

export interface SyncRunResult {
    ran: SyncSource[];
    changed: SyncSource[];
    failures: SyncFailure[];
}

export interface SyncStatus {
    running: boolean;
    /** The source being worked on while `running`. */
    current?: SyncSource;
    /** The entity the running run belongs to. */
    runningEntityId?: string;
    /** Epoch ms of the entity's last run that finished without any failure. */
    lastSuccessAt?: number;
    /** The entity's newest failure still unresolved (cleared by its next fully clean run). */
    lastError?: SyncFailure;
}

export interface SyncServiceDeps {
    runners: Record<SyncSource, SyncRunner>;
    schedule: () => SyncSchedule;
    now: () => number;
}

export interface SyncService {
    /** Running state is global; `lastSuccessAt`/`lastError` are those of `entityId` (never another firm's). */
    status(entityId?: string): SyncStatus;
    subscribe(listener: () => void): () => void;
    /**
     * Start a run now. A run for the same entity already in flight is joined. A run for another
     * entity waits for the current one and then runs (one queued run per entity).
     */
    run(request: SyncRequest): Promise<SyncRunResult>;
    /** The timer entry point: runs what is due for the entity, unless something is running. */
    tick(request: Omit<SyncRequest, 'trigger'>): Promise<SyncRunResult | null>;
}

interface Queued {
    request: SyncRequest;
    sources: SyncSource[];
    promise: Promise<SyncRunResult>;
    start: () => void;
}

interface EntityOutcome {
    lastSuccessAt?: number;
    lastError?: SyncFailure;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
    // Keyed by entity AND source: another firm's sync says nothing about this one.
    const history = new Map<string, SourceHistory>();
    const outcomes = new Map<string, EntityOutcome>();
    const listeners = new Set<() => void>();
    let running: { entityId: string; promise: Promise<SyncRunResult> } | null = null;
    let current: SyncSource | undefined;
    const queue = new Map<string, Queued>();

    const publish = (): void => {
        for (const listener of listeners) listener();
    };
    const key = (entityId: string, source: SyncSource): string => `${entityId}\u0000${source}`;

    async function execute(request: SyncRequest, sources: SyncSource[]): Promise<SyncRunResult> {
        const entityId = request.entity.id;
        const result: SyncRunResult = { ran: [], changed: [], failures: [] };
        for (const source of sources) {
            current = source;
            publish();
            const k = key(entityId, source);
            const h = history.get(k) ?? { failures: 0 };
            history.set(k, h);
            h.lastAttemptAt = deps.now();
            result.ran.push(source);
            try {
                const { changed } = await deps.runners[source](request.entity);
                h.failures = 0;
                if (changed) result.changed.push(source);
            } catch (err) {
                h.failures += 1;
                result.failures.push({
                    source,
                    message: err instanceof Error ? err.message : String(err),
                    at: deps.now(),
                });
            }
        }
        const failed = result.failures[result.failures.length - 1];
        const before = outcomes.get(entityId);
        outcomes.set(entityId, {
            lastSuccessAt: failed ? before?.lastSuccessAt : deps.now(),
            lastError: failed ?? undefined,
        });
        return result;
    }

    function begin(request: SyncRequest, sources: SyncSource[]): Promise<SyncRunResult> {
        // Marked running BEFORE execute() starts: it publishes synchronously up to its first await.
        running = { entityId: request.entity.id, promise: Promise.resolve(null as never) };
        const promise = execute(request, sources).finally(() => {
            running = null;
            current = undefined;
            const next = queue.values().next().value as Queued | undefined;
            if (next) {
                queue.delete(next.request.entity.id);
                next.start();
            }
            publish();
        });
        running.promise = promise;
        return promise;
    }

    return {
        status(entityId) {
            const o = entityId ? outcomes.get(entityId) : undefined;
            return {
                running: running !== null,
                current,
                runningEntityId: running?.entityId,
                lastSuccessAt: o?.lastSuccessAt,
                lastError: o?.lastError,
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        run(request) {
            const id = request.entity.id;
            if (running?.entityId === id) return running.promise;
            const queued = queue.get(id);
            if (queued) return queued.promise;
            const sources = prioritize(request.view, applicableSources(request.entity));
            if (!running) return begin(request, sources);
            let start: () => void = () => {};
            const promise = new Promise<SyncRunResult>((resolve, reject) => {
                start = () => begin(request, sources).then(resolve, reject);
            });
            queue.set(id, { request, sources, promise, start });
            return promise;
        },
        async tick(request) {
            if (running) return null;
            const id = request.entity.id;
            const hist: Partial<Record<SyncSource, SourceHistory>> = {};
            for (const source of applicableSources(request.entity)) {
                const h = history.get(key(id, source));
                if (h) hist[source] = h;
            }
            const due = dueSources(deps.now(), hist, deps.schedule(), applicableSources(request.entity));
            if (due.length === 0) return null;
            return begin({ ...request, trigger: 'auto' }, prioritize(request.view, due));
        },
    };
}
