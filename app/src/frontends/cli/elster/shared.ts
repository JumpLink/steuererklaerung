import { loadManifest } from '../../../core/config/manifest.ts';
import { resolveEntity } from '../../../core/config/accessors.ts';
import { defaultEntityFor, requireEntity, resolveEntityAccounts } from '../../../core/config/entities.ts';
import type { ElsterConfig } from '../../../core/config/schema/elster.ts';
import type { EstConfig } from '../../../core/config/schema/est.ts';
import { transactionsSummary } from '../../../core/actions/transactions.ts';
import { requireTaxModule, type Capability } from '../../../core/countries/index.ts';
import { pickArgv } from '../output.ts';

/** Form types that can be captured as a filing snapshot / signed off / submitted. */
export const SNAPSHOT_FORMS = ['ustva', 'euer', 'uste', 'gewst', 'feststellung', 'est'] as const;

/**
 * Resolve the manifest entity a command should act on: an explicit `--entity` (fail-loud via
 * {@link requireEntity} with the known-id list), else the default business/privat entity. `kind`
 * biases the no-`--entity` default (`'privat'` for the ESt command).
 */
function resolveEntityId(entityId: string | undefined, kind?: string) {
    const manifest = loadManifest();
    const entity = entityId ? requireEntity(manifest, entityId) : defaultEntityFor(manifest, kind);
    return resolveEntity(manifest, entity.id);
}

/**
 * `elster` subcommands that stay available with the tax module off (ADR 0001): the EÜR report is the
 * bookkeeping view of the year, explain/reclassify edit categorisation, and setup installs ERiC
 * without touching an entity. Everything else prepares, checks or sends a German return.
 */
const BOOKKEEPING_SUBCOMMANDS = ['euer report', 'explain', 'reclassify', 'setup'];

/**
 * Refuse a German-tax-only command for an entity whose tax module is off. Resolves the same entity
 * the command would (`--entity`, else the default; `privat` for `est` and `zve`), so the refusal names it. A
 * manifest that cannot be read is left to the command itself, which reports it in its own words.
 */
export function refuseWhenTaxOff(path: string[], argv: Record<string, unknown>, capability?: Capability): void {
    const sub = path.join(' ');
    if (BOOKKEEPING_SUBCOMMANDS.some((b) => sub === b || sub.startsWith(`${b} `))) return;
    const privat = path[0] === 'est' || path[0] === 'zve';
    let entity;
    try {
        entity = resolveEntityId(pickArgv<string>(argv, 'entity'), privat ? 'privat' : undefined);
    } catch {
        return;
    }
    requireTaxModule(entity, capability ?? (privat ? 'incomeTax' : 'taxFiling'));
}

/** {@link refuseWhenTaxOff} as yargs middleware: print the refusal and exit non-zero. */
export function exitWhenTaxOff(path: string[], argv: Record<string, unknown>): void {
    try {
        refuseWhenTaxOff(path, argv);
    } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    }
}

/**
 * The account scope for a report. An explicit `--account-key` always wins; otherwise `--entity` scopes
 * the report to exactly that manifest entity's accounts. Returns undefined only when NEITHER is given —
 * the action then derives the scope from the ELSTER config's entity (never a blanket `camt:*` sum).
 *
 * A given-but-unresolvable `--entity` (unknown id via {@link requireEntity}, or an entity that owns no
 * store accounts) THROWS instead of silently falling through. Callers invoke this inside their
 * try/catch, so the message is printed and the command exits non-zero.
 */
export function accountKeysFrom(raw: Record<string, unknown>): string[] | undefined {
    const keys = (raw['account-key'] as unknown[] | undefined)?.map(String).filter(Boolean) ?? [];
    if (keys.length) return keys;
    const entityId = pickArgv<string>(raw, 'entity');
    if (!entityId) return undefined;
    const entity = requireEntity(loadManifest(), entityId);
    const accountKeys = resolveEntityAccounts(
        entity,
        transactionsSummary().accounts.map((a) => a.accountKey),
    );
    if (accountKeys.length === 0) {
        throw new Error(
            `Entität '${entityId}' hat keine Konten im Store (accounts: ${entity.accounts.join(', ') || '—'}). ` +
                'Erst Transaktionen importieren/synchronisieren oder --account-key explizit setzen.',
        );
    }
    return accountKeys;
}

/**
 * Load the ELSTER config for the resolved manifest entity, folding any `--year`/`--quarter`/`--month`
 * overrides into the period. `--entity` selects the entity (fail-loud on an unknown id); without it the
 * default business entity is used. Shared by every subcommand that reads an ELSTER config.
 */
export function parseElsterArgs(argv: Record<string, unknown>): ElsterConfig {
    const entity = resolveEntityId(pickArgv<string>(argv, 'entity'));
    if (!entity.elster) {
        throw new Error(
            `Entität '${entity.id}' hat keine ELSTER-Config (elster-Abschnitt im steuererklaerung.json fehlt).`,
        );
    }
    let config = entity.elster;
    const year = pickArgv<number>(argv, 'year');
    const quarter = pickArgv<number>(argv, 'quarter');
    const month = pickArgv<number>(argv, 'month');
    if (year != null || quarter != null || month != null) {
        config = {
            ...config,
            // schema_version MUST track the filing year: it drives the `ustva/v<year>` namespace +
            // the derived ERiC datenartVersion (UStVA_<year>). Overriding --year without it left the
            // namespace at the config default (e.g. v2025) while <Jahr> became 2026 → ERiC rejects
            // with UStVA_Jahr_gleich_VZ. The annual forms take the year straight from --year, but for
            // UStVA the two must stay equal (see ustva-xml.ts generateUstvaXmlForPeriod).
            schema_version: year ?? config.schema_version,
            period: {
                year: year ?? config.period.year,
                quarter: quarter ?? (month == null ? config.period.quarter : undefined),
                month: month ?? (quarter == null ? config.period.month : undefined),
            },
        };
    }
    return config;
}

/**
 * Load the private-ESt config for the resolved manifest entity (`--entity`, else the default `privat`
 * entity). Fail-loud when the entity has no `est` section. Used by the `elster est` subcommands.
 */
export function parseEstArgs(argv: Record<string, unknown>): EstConfig {
    const entity = resolveEntityId(pickArgv<string>(argv, 'entity'), 'privat');
    if (!entity.est) {
        throw new Error(`Entität '${entity.id}' hat keine ESt-Config (est-Abschnitt im steuererklaerung.json fehlt).`);
    }
    return entity.est;
}
