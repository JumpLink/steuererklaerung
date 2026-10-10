/**
 * Enumerate the workspace's entities and derive each one's upcoming statutory deadlines
 * (see `elster/steuertermine.ts`). This is the proactive companion to `listOpenItems`
 * (actions/fristen.ts). Read-only; shared by the CLI, the MCP tool and the app/web views.
 */

import { loadManifest, resolveEntities, type ElsterConfig } from '../config/index.ts';
import { capabilities } from '../countries/index.ts';
import { computeSteuertermine, type SteuerTermin, type SteuerTerminEntity } from '../elster/steuertermine.ts';
import { formForFilingKind } from './elster/filing-keys.ts';
import { listFilingSnapshots, type FilingSnapshot } from './elster/snapshots.ts';
import { listFilings } from './filings.ts';

/**
 * A `submitted` snapshot for one deadline slot, or null.
 *
 * Looked up per gap rather than by reading every snapshot up front: gaps are
 * rare, and a full scan would cost a query per entity-year whether or not
 * anything was missing.
 */
function submittedSnapshotFor(entityId: string, kind: string, period: string): FilingSnapshot | null {
    const form = formForFilingKind(kind);
    if (!form) return null;
    // `est` has no XML builder, so it is never snapshotted by the tool itself —
    // except when `recordWebFiling` captured one. Both cases are handled by
    // simply asking; an entity/year with no snapshots answers with an empty list.
    const year = Number.parseInt(period.slice(0, 4), 10);
    if (!Number.isFinite(year)) return null;
    try {
        const rows = listFilingSnapshots(entityId, year, form).filter((s) => s.status === 'submitted');
        if (rows.length === 0) return null;
        // A periodic form's snapshots all live under the same year, so the
        // sub-year label decides which one this deadline is about.
        const scoped = period.includes('-')
            ? rows.filter((s) => (s.figures as { period?: string } | undefined)?.period === period)
            : rows;
        return scoped[0] ?? null;
    } catch {
        // An unreadable ledger must not take the whole deadline list down; the
        // register annotation above already ran.
        return null;
    }
}

/**
 * Map an entity's config to the minimal shape `computeSteuertermine` needs. `elster` drives the
 * business deadlines (USt-VA + annuals); a present `est` config adds the private ESt deadline —
 * an entity may carry either or both.
 *
 * A Kleinunternehmer files neither USt-VA nor, since VZ 2024, a USt-Jahreserklärung (§19 Abs. 1
 * UStG); a business the Finanzamt released from Voranmeldungen (§18 Abs. 2 S. 3 UStG) still files
 * the annual one. Sources: docs/references/tax-sources.md (§18/§19 UStG).
 */
export function toSteuerTerminEntity(
    entityId: string,
    entityName: string,
    elster: ElsterConfig | undefined,
    filesEst: boolean,
    kleinunternehmer = false,
): SteuerTerminEntity {
    const filesUstva = elster != null && !kleinunternehmer && !elster.ust_va_befreit;
    const ustCadence: 'quarter' | 'month' | null = !filesUstva
        ? null
        : elster.period.quarter != null
          ? 'quarter'
          : elster.period.month != null
            ? 'month'
            : null;
    return {
        entityId,
        entityName,
        ustCadence,
        dauerfrist: elster?.ust_dauerfristverlaengerung ?? false,
        filesUst:
            elster != null &&
            !kleinunternehmer &&
            (ustCadence != null || elster.ust_va_befreit === true || elster.uste != null),
        business: elster != null,
        isGbr: (elster?.gesellschafter.length ?? 0) > 0,
        hasGewerbe: elster?.gewerbe != null,
        businessStart: elster?.business_start_date,
        businessEnd: elster?.business_end_date,
        filesEst,
    };
}

/**
 * Upcoming Regelfrist-Steuertermine across every entity that has an ELSTER config (business
 * deadlines) and/or an ESt config (the private Einkommensteuer deadline), merged and ranked by
 * due date. `today` (YYYY-MM-DD) defaults to the current date; pass it for deterministic
 * output. A single unreadable entity config is skipped, not fatal.
 */
export function listSteuertermine(opts: { today?: string; horizonDays?: number } = {}): SteuerTermin[] {
    const today = opts.today ?? new Date().toISOString().slice(0, 10);

    const entities: SteuerTerminEntity[] = [];
    try {
        for (const e of resolveEntities(loadManifest())) {
            if (!e.elster && !e.est) continue;
            if (!capabilities(e).taxDeadlines) continue;
            // `abgabe_extern` ⇒ this person files their own ESt elsewhere. The
            // computation stays available; only the DEADLINE is not ours to
            // carry, and a standing reminder about someone else's duty is the
            // one people learn to ignore — together with their own.
            entities.push(
                toSteuerTerminEntity(
                    e.id,
                    e.name,
                    e.elster,
                    e.est != null && !e.est.abgabe_extern,
                    e.invoicing.self?.issuer?.kleinunternehmer === true,
                ),
            );
        }
    } catch (err) {
        // A missing/invalid manifest must not throw here — it must NOT be swallowed silently either:
        // without it, every entity's deadlines vanish from the proactive monitoring without a trace.
        // Warn (stderr, so it never pollutes MCP stdout / report JSON) so the outage is visible.
        console.warn(
            `[steuertermine] Manifest (steuererklaerung.json) nicht ladbar — keine proaktiven Steuertermine: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const all = entities.flatMap((e) => computeSteuertermine(e, today, opts.horizonDays));

    // Annotate with the register: a (entityId, kind, period) that has a filing is eingereicht/bezahlt.
    // Keyed lookup so we read the whole register once, not per termin.
    const filings = listFilings();
    const byKey = new Map(filings.map((f) => [`${f.entityId}:${f.kind}:${f.period}`, f]));
    for (const t of all) {
        const f = byKey.get(t.key);
        if (f) {
            if (f.paidAt) t.status = 'bezahlt';
            else if (f.filedAt) t.status = 'eingereicht';
            if (f.filedAt) t.filedAt = f.filedAt;
            if (f.paidAt) t.paidAt = f.paidAt;
            continue;
        }
        // No register row — but the register is not the only place a filing
        // leaves a trace. Its snapshot carries ELSTER's own receipt, and the
        // two used to be written by different code paths: the tool's live send
        // wrote the snapshot and nothing else, so a return that had gone out
        // was still reported as overdue. Look there before believing "open",
        // and SAY that the two disagree rather than papering over it.
        const evidence = submittedSnapshotFor(t.entityId, t.kind, t.period);
        if (!evidence) continue;
        t.status = 'eingereicht';
        if (evidence.submittedAt) t.filedAt = evidence.submittedAt;
        t.registerGap =
            `Übermittelt laut Übertragungsprotokoll${evidence.submittedAt ? ` am ${evidence.submittedAt}` : ''}` +
            `${evidence.transferTicket ? ` (Transferticket ${evidence.transferTicket})` : ''}, ` +
            'aber ohne Eintrag im Abgaberegister — mit `filing record` nachtragen.';
    }

    all.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.key < b.key ? -1 : 1));
    return all;
}
