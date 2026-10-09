/**
 * Shared entity + reporting-year resolver — the ONE probe both the web server
 * (frontends/web/server.ts) and the native desktop app (frontends/desktop/entities.ts) now consume,
 * replacing the twin `candidateYears` / `yearsWithData` blocks each of them carried.
 *
 * Pure TS — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod. It runs on GJS in every frontend and its
 * JSON is what the browser sees. It opens the local store (via the transactions action), resolves the
 * workspace manifest (steuererklaerung.json) into entities, and attaches each entity's years-with-data plus
 * its ELSTER/ESt availability. Synchronous + cheap (a handful of indexed store counts, no outbound I/O).
 */

import { loadAppSettings, resolveWorkspaceEntities, type ElsterConfig, type EstConfig } from '../config/index.ts';
import { searchTransactions, transactionsSummary } from '../actions/transactions.ts';

/**
 * One legal entity as the frontends need it — the merge of the desktop `AppEntity` and the web's
 * entity-meta shape. The entity's ELSTER / private-ESt configs are now INLINE (resolved from the
 * consolidated manifest) rather than lazily loaded from a path.
 */
export interface EntityModel {
    /** Stable id used in the API (`?entity=`) and localStorage. */
    id: string;
    /** Display name for the switcher + header. */
    name: string;
    /** gbr · einzelunternehmen · privat · … (display/grouping). */
    kind: string;
    /** Whether an ELSTER config is present — gates the Steuer view. */
    hasElster: boolean;
    /** Whether a private-ESt config is present — gates the Einkommensteuer view for a `privat` entity. */
    hasEst: boolean;
    /** The entity's inline ELSTER config (normalised), if any — used by the Steuer/EÜR view. */
    elster?: ElsterConfig;
    /** The entity's inline private-ESt config, if any — used by the Einkommensteuer view. */
    est?: EstConfig;
    /** Reporting years (oldest → newest) in which the entity has any transaction. */
    years: number[];
    /** Newest year with data, else the newest probed year. */
    defaultYear: number;
    /** Concrete store account keys this entity owns (after glob expansion). */
    accountKeys: string[];
    /**
     * Which Beleg back-end the entity is on. Present because the USt-VA aggregate reads from
     * Paperless and ONLY from Paperless: on a built-in-DMS entity it failed with a Paperless
     * config error, which reads as "Paperless is broken" when the truth is "this entity does not
     * use Paperless at all" — a wrong diagnosis is worse than none.
     */
    dmsType: 'builtin' | 'paperless';
    /** True for the fictional demo entity — drives the persistent "Demodaten" banner. */
    demo?: boolean;
}

export interface WorkspaceModel {
    entities: EntityModel[];
    defaultEntity: string;
    /** Whether the built-in assistant is enabled (gates the web Assistent view). */
    assistant: boolean;
}

/**
 * Probe the last ~8 years up to the current year; the real set is whatever actually has rows.
 * `new Date()` is normal app-runtime code here (the same the desktop/web probes already used) — only
 * gjsify workflow *scripts* forbid it.
 */
export function candidateYears(): number[] {
    const current = new Date().getFullYear();
    const years: number[] = [];
    for (let y = current - 8; y <= current; y++) years.push(y);
    return years;
}

/** Years (within the candidate set) in which any of the entity's accounts has a transaction. */
function yearsWithData(accountKeys: string[], years: number[]): number[] {
    return years.filter((y) =>
        accountKeys.some((k) => searchTransactions({ accountKey: k, from: `${y}-01-01`, to: `${y}-12-31` }).count > 0),
    );
}

/**
 * The unified workspace resolver: resolve the manifest exactly as the desktop's `loadAppWorkspace()`
 * did, honouring an explicit `years` override like the web server's `--years`. Both frontends call this
 * so they offer the same entities + year switcher. Tolerant: a missing/broken ELSTER or ESt config just
 * leaves `hasElster` / `hasEst` false (the corresponding view stays hidden), never a throw.
 */
export function loadWorkspaceModel(opts: { years?: number[] } = {}): WorkspaceModel {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const resolved = resolveWorkspaceEntities(storeKeys);
    const probe = opts.years?.length ? opts.years : candidateYears();

    const entities: EntityModel[] = resolved.map((entity) => {
        const years = yearsWithData(entity.accountKeys, probe);
        return {
            id: entity.id,
            name: entity.name,
            kind: entity.kind,
            hasElster: !!entity.elster,
            hasEst: !!entity.est,
            elster: entity.elster,
            est: entity.est,
            years,
            defaultYear: years[years.length - 1] ?? probe[probe.length - 1],
            accountKeys: entity.accountKeys,
            dmsType: entity.dms?.type === 'paperless' ? 'paperless' : 'builtin',
            demo: entity.demo,
        };
    });

    // Default to the first entity that actually has data, else the first listed.
    const defaultEntity = (entities.find((e) => e.years.length) ?? entities[0])?.id ?? 'default';
    const assistant = loadAppSettings().assistant.enabled;
    return { entities, defaultEntity, assistant };
}

/**
 * Resolve an entity by id, falling back to the workspace's default entity (the web's
 * fallback-to-default semantics). The CLI's fail-loud `--entity` stays in the CLI — this resolver is
 * for the tolerant web/desktop/session paths.
 */
export function entityOf(ws: WorkspaceModel, id?: string): EntityModel | undefined {
    return ws.entities.find((e) => e.id === id) ?? ws.entities.find((e) => e.id === ws.defaultEntity);
}
