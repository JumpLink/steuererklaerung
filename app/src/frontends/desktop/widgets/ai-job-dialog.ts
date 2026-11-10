/**
 * <BhAiJobDialog> — a reusable runner for one-shot AI document jobs.
 *
 * Used for invoice-field extraction, document classification and metadata review.
 * The dialog shows a loading state with a cancel button, then a result summary.
 * Cancelling stops the in-flight AI call and surfaces the catalogue's cancelled
 * message as a toast rather than an error page. Documents already processed keep
 * their changes when the job is cancelled.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

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
    /** Hint about what cancellation means for already-processed documents. */
    safeHint?: string;
    /** Run the job. Receives the abort signal the cancel button controls. */
    run(signal: AbortSignal): Promise<T>;
}

function centerBox(spacing: number): Gtk.Box {
    return new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        spacing,
        marginStart: 24,
        marginEnd: 24,
    });
}

export class BhAiJobDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly stack = new Gtk.Stack();
    private readonly errorPage = new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: _('The AI task failed'),
    });
    private readonly resultDescription = new Gtk.Label({
        label: '',
        cssClasses: ['dim-label'],
        wrap: true,
        maxWidthChars: 36,
        justify: Gtk.Justification.CENTER,
    });
    private readonly resultClose = new Gtk.Button({
        label: _('Close'),
        halign: Gtk.Align.CENTER,
        marginTop: 18,
    });
    private readonly descriptionLabel = new Gtk.Label({
        label: '',
        cssClasses: ['dim-label'],
        wrap: true,
        maxWidthChars: 32,
        justify: Gtk.Justification.CENTER,
    });
    private readonly safeHintLabel = new Gtk.Label({
        label: '',
        cssClasses: ['caption', 'dim-label'],
        wrap: true,
        maxWidthChars: 32,
        justify: Gtk.Justification.CENTER,
    });
    private readonly cancelButton = new Gtk.Button({ label: _('Cancel'), halign: Gtk.Align.CENTER });
    private controller: AbortController | null = null;
    private ended = false;

    constructor() {
        this.dialog.set_content_width(420);
        this.dialog.set_content_height(360);

        const loading = this.buildLoadingPage();
        const result = this.buildResultPage();
        this.stack.add_named(loading, 'loading');
        this.stack.add_named(this.errorPage, 'error');
        this.stack.add_named(result, 'result');

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
        this.cancelButton.set_sensitive(true);
        this.dialog.present(parent);
        phoneSizeDialog(this.dialog, 360, parent);
        this.setLoadingText(spec);
        this.start(spec);
    }

    private buildLoadingPage(): Gtk.Widget {
        const box = centerBox(12);
        box.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        const title = new Gtk.Label({
            label: _('Running AI task …'),
            cssClasses: ['heading'],
        });
        box.append(title);
        this.descriptionLabel.set_visible(false);
        box.append(this.descriptionLabel);
        this.safeHintLabel.set_visible(false);
        box.append(this.safeHintLabel);
        this.cancelButton.connect('clicked', () => this.cancel());
        box.append(this.cancelButton);
        return box;
    }

    private buildResultPage(): Gtk.Widget {
        const box = centerBox(12);
        const icon = new Gtk.Image({ iconName: 'emblem-ok-symbolic', pixelSize: 48 });
        icon.add_css_class('success-color');
        box.append(icon);
        const title = new Gtk.Label({
            label: _('Done'),
            cssClasses: ['heading'],
        });
        box.append(title);
        box.append(this.resultDescription);
        this.resultClose.add_css_class('pill');
        this.resultClose.connect('clicked', () => this.dialog.close());
        box.append(this.resultClose);
        return box;
    }

    private setLoadingText(spec: AiJobSpec<AiJobResult>): void {
        this.descriptionLabel.set_label(spec.loadingDescription);
        this.descriptionLabel.set_visible(true);
        if (spec.safeHint) {
            this.safeHintLabel.set_label(spec.safeHint);
            this.safeHintLabel.set_visible(true);
        } else {
            this.safeHintLabel.set_visible(false);
        }
    }

    private start<T extends AiJobResult>(spec: AiJobSpec<T>): void {
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
        this.cancelButton.set_sensitive(false);
        this.resultDescription.set_label(result.summary.join('\n'));
        this.stack.set_visible_child_name('result');
    }

    private onError(err: unknown): void {
        if (this.ended) return;
        this.ended = true;
        this.cancelButton.set_sensitive(false);
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
        this.cancelButton.set_sensitive(false);
        this.cancelInternal();
        this.dialog.close();
    }

    private cancelInternal(): void {
        if (this.ended) return;
        this.ended = true;
        this.cancelButton.set_sensitive(false);
        this.controller?.abort();
    }
}
