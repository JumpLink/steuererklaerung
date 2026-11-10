/**
 * <BhAiJobDialog> — a reusable runner for one-shot AI document jobs.
 *
 * Used for invoice-field extraction, document classification and metadata review.
 * The dialog shows a loading state with a cancel button, then a result summary.
 * Cancelling stops the in-flight AI call, leaves no partial writes behind, and
 * surfaces the catalogue's cancelled message as a toast rather than an error.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GLib from '@girs/glib-2.0';

import { AiJobError } from '../../../core/clients/llm/job-error.ts';
import { _ } from '../i18n.ts';
import { showToast } from '../toast.ts';
import { phoneSizeDialog } from './responsive.ts';

export interface AiJobResult {
    /** Short human-readable summary lines shown on the result page. */
    summary: string[];
}

export interface AiJobSpec<T extends AiJobResult> {
    /** Dialog title, also used for the header bar. */
    title: string;
    /** One-line description of what the AI is doing while the spinner runs. */
    loadingDescription: string;
    /** Hint that nothing is saved automatically unless the job says so. */
    safeHint?: string;
    /** Run the job. Receives the abort signal the cancel button controls. */
    run(signal: AbortSignal): Promise<T>;
}

export class BhAiJobDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly stack = new Gtk.Stack();
    private readonly errorPage = new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: _('The AI task failed'),
    });
    private readonly resultPage = new Adw.StatusPage({
        iconName: 'emblem-ok-symbolic',
        title: _('Done'),
    });
    private controller: AbortController | null = null;
    private ended = false;

    constructor() {
        this.dialog.set_content_width(420);
        this.dialog.set_content_height(360);

        const loading = this.buildLoadingPage();
        this.stack.add_named(loading, 'loading');
        this.stack.add_named(this.errorPage, 'error');
        this.stack.add_named(this.resultPage, 'result');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(this.stack);
        this.dialog.set_child(toolbar);

        this.dialog.connect('closed', () => this.cancelInternal());
    }

    open<T extends AiJobResult>(parent: Gtk.Widget, spec: AiJobSpec<T>): void {
        this.dialog.set_title(spec.title);
        this.ended = false;
        this.stack.set_visible_child_name('loading');
        this.dialog.present(parent);
        phoneSizeDialog(this.dialog, 360, parent);
        this.start(spec);
    }

    private buildLoadingPage(): Gtk.Widget {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
            marginStart: 24,
            marginEnd: 24,
        });
        box.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        const title = new Gtk.Label({
            label: _('Running AI task …'),
            cssClasses: ['heading'],
        });
        box.append(title);
        const description = new Gtk.Label({
            label: '',
            cssClasses: ['dim-label'],
            wrap: true,
            maxWidthChars: 32,
            justify: Gtk.Justification.CENTER,
        });
        description.set_visible(false);
        box.append(description);
        const safeHint = new Gtk.Label({
            label: _('Nothing is saved until the task finishes successfully.'),
            cssClasses: ['caption', 'dim-label'],
            wrap: true,
            maxWidthChars: 32,
            justify: Gtk.Justification.CENTER,
        });
        safeHint.set_visible(false);
        box.append(safeHint);
        const cancel = new Gtk.Button({ label: _('Cancel'), halign: Gtk.Align.CENTER });
        cancel.connect('clicked', () => this.cancel());
        box.append(cancel);
        // Attach refs so open() can fill them from the spec.
        (box as unknown as { descriptionLabel: Gtk.Label; safeHintLabel: Gtk.Label }).descriptionLabel = description;
        (box as unknown as { safeHintLabel: Gtk.Label }).safeHintLabel = safeHint;
        return box;
    }

    private setLoadingText(spec: AiJobSpec<AiJobResult>): void {
        const loading = this.stack.get_child_by_name('loading') as Gtk.Box | null;
        if (!loading) return;
        const refs = loading as unknown as { descriptionLabel: Gtk.Label; safeHintLabel: Gtk.Label };
        if (refs.descriptionLabel) {
            refs.descriptionLabel.set_label(spec.loadingDescription);
            refs.descriptionLabel.set_visible(true);
        }
        if (refs.safeHintLabel && spec.safeHint) {
            refs.safeHintLabel.set_label(spec.safeHint);
            refs.safeHintLabel.set_visible(true);
        }
    }

    private start<T extends AiJobResult>(spec: AiJobSpec<T>): void {
        this.setLoadingText(spec);
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        Promise.resolve()
            .then(() => spec.run(controller.signal))
            .then((result) => this.onSuccess(result))
            .catch((err: unknown) => this.onError(err));
    }

    private onSuccess<T extends AiJobResult>(result: T): void {
        if (this.ended) return;
        this.ended = true;
        this.resultPage.set_description(result.summary.join('\n'));
        this.stack.set_visible_child_name('result');
        // Auto-close after a short pause so the user can read the summary.
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this.dialog.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    private onError(err: unknown): void {
        if (this.ended) return;
        this.ended = true;
        if (err instanceof AiJobError && err.kind === 'cancelled') {
            this.dialog.close();
            showToast(_('The AI task was cancelled.'));
            return;
        }
        this.errorPage.set_description(err instanceof Error ? err.message : String(err));
        this.stack.set_visible_child_name('error');
    }

    /** User pressed the cancel button: abort and close. */
    cancel(): void {
        this.cancelInternal();
        this.dialog.close();
    }

    private cancelInternal(): void {
        if (this.ended) return;
        this.ended = true;
        this.controller?.abort();
    }
}
