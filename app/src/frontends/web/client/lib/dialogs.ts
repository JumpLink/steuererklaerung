// Shared Adwaita confirmation dialogs built on <adw-alert-dialog>. Replaces the
// hand-rolled .bh-modal-backdrop / .bh-dialog-backdrop overlays for confirmations:
// one transient dialog is appended to <body>, presented, and removed once the user
// picks a response (or dismisses via Escape / scrim → the close-response). Heading
// and labels are passed as text (the element sets them as textContent, so no esc()
// needed here). Moves the app one step closer to native GTK Adw.AlertDialog.

import type { Adw } from '@gjsify/adwaita-web';
import { qc } from './dom.ts';

export interface AlertChoice {
    /** Stable id resolved when this button is chosen. */
    id: string;
    /** Visible button label. */
    label: string;
    /** Adwaita button styling (suggested = accent, destructive = red). */
    appearance?: 'default' | 'suggested' | 'destructive';
}

export interface AlertOptions {
    heading: string;
    body?: string;
    /** Buttons, in display order. */
    choices: AlertChoice[];
    /** Response id used on dismissal (Escape / scrim). Default: the first non-destructive choice. */
    closeId?: string;
    /** Response id highlighted as the default (focused) button. Default: the close id. */
    defaultId?: string;
}

/**
 * Present a modal <adw-alert-dialog> and resolve with the chosen response id.
 * Resolves with the close-response id when dismissed via Escape or scrim click.
 */
export function alertDialog(opts: AlertOptions): Promise<string> {
    return new Promise((resolve) => {
        const dlg = qc<Adw.AlertDialog>('adw-alert-dialog');
        // The element renders its shell on connect; set content + responses afterwards.
        document.body.appendChild(dlg);
        dlg.heading = opts.heading;
        if (opts.body) dlg.body = opts.body;
        for (const ch of opts.choices) {
            dlg.addResponse(ch.id, ch.label);
            if (ch.appearance && ch.appearance !== 'default') dlg.setResponseAppearance(ch.id, ch.appearance);
        }
        const closeId =
            opts.closeId ?? opts.choices.find((c) => (c.appearance ?? 'default') === 'default')?.id ?? opts.choices[0].id;
        dlg.closeResponse = closeId;
        dlg.defaultResponse = opts.defaultId ?? closeId;

        let settled = false;
        dlg.addEventListener('response', (e) => {
            if (settled) return; // the element also emits on dismissal — guard against a double-settle
            settled = true;
            const id = (e as CustomEvent<{ response: string }>).detail.response;
            dlg.remove();
            resolve(id);
        });
        dlg.present();
    });
}

export interface ConfirmOptions {
    heading: string;
    body?: string;
    confirmLabel: string;
    cancelLabel?: string;
    /** Style the confirm button as a red destructive action. */
    destructive?: boolean;
}

/** Yes/no confirmation: resolves true iff the confirm button was chosen (cancel/dismiss → false). */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
    return alertDialog({
        heading: opts.heading,
        ...(opts.body ? { body: opts.body } : {}),
        choices: [
            { id: 'cancel', label: opts.cancelLabel ?? 'Abbrechen' },
            { id: 'confirm', label: opts.confirmLabel, appearance: opts.destructive ? 'destructive' : 'suggested' },
        ],
        closeId: 'cancel',
        defaultId: 'cancel',
    }).then((id) => id === 'confirm');
}
