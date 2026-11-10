/**
 * Pure helper for formatting AI-job result counters. Kept outside the GTK dialog so tests can
 * import it without pulling in libadwaita.
 */
import { fmt, _, _n } from '../i18n-helpers.ts';

/** Build a summary from the common AI-job result counters. */
export function aiJobSummaryLines(opts: {
    processed: number;
    updated?: number;
    changed?: number;
    skipped?: number;
    errors?: number;
}): string[] {
    const lines: string[] = [];
    lines.push(fmt(_n('{n} document processed', '{n} documents processed', opts.processed), { n: opts.processed }));
    if (opts.updated != null) {
        lines.push(fmt(_n('{n} updated', '{n} updated', opts.updated), { n: opts.updated }));
    }
    if (opts.changed != null) {
        lines.push(fmt(_n('{n} changed', '{n} changed', opts.changed), { n: opts.changed }));
    }
    if (opts.skipped != null) {
        lines.push(fmt(_n('{n} document skipped', '{n} documents skipped', opts.skipped), { n: opts.skipped }));
    }
    if (opts.errors != null && opts.errors > 0) {
        lines.push(fmt(_n('{n} error', '{n} errors', opts.errors), { n: opts.errors }));
    }
    return lines;
}
