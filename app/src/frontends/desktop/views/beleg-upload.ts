/**
 * Adding a receipt from the native app.
 *
 * There was no file upload anywhere in the desktop tree — the only `Gtk.FileDialog`s were the ERiC
 * keystore picker and Speichern-unter. A receipt got into the built-in DMS by dropping it into the
 * web UI or by hand; the Beleg-Eingang list could only ever review what something else had put
 * there. For an app whose central promise is "Belege mit Buchungen verknüpfen", that is a hole in
 * the middle of it.
 *
 * The rules — which types, how large, what date — are NOT here. They live in the shared
 * `core/actions/documents.ts` alongside the web route's, so the two surfaces cannot drift into
 * accepting different files.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { RECEIPT_FORMATS_LABEL, RECEIPT_PATTERNS, storeReceipt } from '../../../core/actions/documents.ts';
import { dmsProviderFor } from '../data/dms.ts';
import type { AppEntity } from '../entities.ts';
import { markup } from './util.ts';
import { _, _n, fmt } from '../i18n.ts';

export interface UploadOutcome {
    stored: number;
    failed: Array<{ filename: string; reason: string }>;
}

/**
 * Pick one or more receipts and store them.
 *
 * MULTI-select on purpose: receipts arrive as a stack, and a picker that takes one file at a time
 * turns "add this month's invoices" into twelve trips through the same dialog.
 *
 * Each file is stored independently and a failure does not abort the rest — with ten files picked,
 * one unsupported type must not cost the other nine. The outcome names every file that failed and
 * why, because "3 von 10 gespeichert" without the list leaves the user guessing which three.
 */
export async function pickAndStoreReceipts(
    parent: Gtk.Window,
    entity: AppEntity,
    year: number,
    opts: { linkTxId?: string } = {},
): Promise<UploadOutcome | null> {
    const paths = await pickReceiptFiles(parent);
    if (paths.length === 0) return null; // cancelled

    const provider = dmsProviderFor(entity);
    const outcome: UploadOutcome = { stored: 0, failed: [] };
    for (const path of paths) {
        const filename = basename(path);
        try {
            await storeReceipt(provider, {
                bytes: readFileSync(path),
                filename,
                viewYear: year,
                linkTxId: opts.linkTxId,
                entityId: entity.id,
            });
            outcome.stored++;
        } catch (err) {
            outcome.failed.push({ filename, reason: err instanceof Error ? err.message : String(err) });
        }
    }
    return outcome;
}

/**
 * Multi-select file picker for receipts.
 *
 * `Gtk.FileDialog` directly rather than `@gjsify/adwaita-app`'s `pickFile`, which only takes ONE
 * file — and receipts arrive as a stack, so a one-at-a-time picker turns "add this month's
 * invoices" into twelve trips through the same dialog. The toolkit deliberately does not hide
 * Adw/GTK, so reaching for the widget underneath is the intended move, not a workaround.
 *
 * Cancelling rejects rather than returning null, hence the catch: a cancelled dialog is a normal
 * outcome, not an error to report.
 */
async function pickReceiptFiles(parent: Gtk.Window): Promise<string[]> {
    const filter = new Gtk.FileFilter({ name: fmt(_('Receipts ({formats})'), { formats: RECEIPT_FORMATS_LABEL }) });
    for (const pattern of RECEIPT_PATTERNS) filter.add_pattern(pattern);
    const filters = new Gio.ListStore({ itemType: Gtk.FileFilter.$gtype });
    filters.append(filter);

    const dialog = new Gtk.FileDialog({ title: _('Add receipt(s)'), filters, defaultFilter: filter });

    return new Promise<string[]>((resolve) => {
        dialog.open_multiple(parent, null, (source, result) => {
            try {
                const model = (source as Gtk.FileDialog).open_multiple_finish(result);
                const out: string[] = [];
                for (let i = 0; i < (model?.get_n_items() ?? 0); i++) {
                    const path = (model?.get_item(i) as Gio.File | null)?.get_path();
                    if (path) out.push(path);
                }
                resolve(out);
            } catch {
                resolve([]); // cancelled or dismissed
            }
        });
    });
}

/** One line summarising an upload, for a toast. */
export function summarizeUpload(outcome: UploadOutcome): string {
    if (outcome.failed.length === 0) {
        return fmt(_n('{n} receipt added', '{n} receipts added', outcome.stored), { n: outcome.stored });
    }
    if (outcome.stored === 0) return fmt(_('No receipt added ({failed} failed)'), { failed: outcome.failed.length });
    return fmt(_('{stored} added, {failed} failed'), { stored: outcome.stored, failed: outcome.failed.length });
}

/**
 * Show what failed, when anything did.
 *
 * A dialog rather than a toast: the toast says how many, and a user who just handed over ten files
 * needs to know WHICH ones did not make it — a message that disappears after four seconds cannot
 * carry that.
 */
export function presentUploadFailures(parent: Gtk.Widget, outcome: UploadOutcome): void {
    if (outcome.failed.length === 0) return;
    const lines = outcome.failed.map((f) => `• ${f.filename}: ${f.reason}`).join('\n');
    const dialog = new Adw.AlertDialog({
        heading: outcome.stored > 0 ? _('Not all receipts could be saved') : _('Receipt could not be saved'),
        body: markup(lines),
    });
    dialog.add_response('close', _('Close'));
    dialog.present(parent);
}
