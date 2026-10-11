/**
 * <BhVertragVorschlagDialog> — what one document says about a contract (ADR 0004, step 5), as a
 * proposal the person accepts field by field.
 *
 * The AI reads the document; this dialog decides nothing. Every field arrives with the passage it was
 * read from and the contract's current value, and only the switches someone leaves on become a write.
 * That is the whole point: a notice period wrong by a month renews a contract for another year, so
 * the reading may not be the thing that saves it.
 *
 * The dialog does not write either — it hands the accepted fields to its caller as a
 * {@link ContractInput}: the detail dialog saves them, the form dialog fills its rows with them, and
 * a contract that does not exist yet therefore stays unsaved until the person presses Save there.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import type { ContractInput } from '@steuererklaerung/store';

import {
    type ContractFieldSuggestion,
    type ContractProposal,
    type ContractProposalField,
    contractInputFromProposal,
    loadContractProposal,
} from '../data/contract-extract.ts';
import type { AppEntity } from '../entities.ts';
import { _, fmt } from '../i18n.ts';
import { scoreBadge } from './beleg-link-dialog.ts';
import { LoadToken, loadIntoStack, markup } from './util.ts';
import { PROPOSAL_FIELD_LABEL, proposalValueText } from './vertrag-labels.ts';

export interface VorschlagHooks {
    entity: AppEntity;
    /** The document to read, as it is attached to the contract (e.g. `paperless:42`). */
    documentRef: string;
    /** The contract whose values the proposal is compared against; absent while creating one. */
    contractId?: string;
    /** The accepted fields, ready for `saveContractRecord` or for filling a form. */
    onApply: (input: ContractInput) => void;
}

export class BhVertragVorschlagDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly stack = new Gtk.Stack();
    private readonly errorPage = new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: _('Could not read the document'),
    });
    private readonly token = new LoadToken();
    /** Cancels the running AI call; replaced per load, aborted when the person cancels or closes. */
    private controller: AbortController | null = null;
    private hooks!: VorschlagHooks;
    /** The switch per offered field — the source of truth for what "accept" means on apply. */
    private switches = new Map<ContractProposalField, Adw.SwitchRow>();

    constructor() {
        this.dialog.set_title(_('Read from document'));
        this.dialog.set_content_width(560);
        this.dialog.set_content_height(620);

        const loading = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
        });
        loading.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        loading.append(new Gtk.Label({ label: _('Reading the document …'), cssClasses: ['dim-label'] }));
        loading.append(
            new Gtk.Label({
                label: _('Nothing is saved — you decide field by field afterwards.'),
                cssClasses: ['caption', 'dim-label'],
            }),
        );
        const cancel = new Gtk.Button({ label: _('Cancel'), halign: Gtk.Align.CENTER });
        cancel.connect('clicked', () => this.cancel());
        loading.append(cancel);
        this.stack.add_named(loading, 'loading');
        this.stack.add_named(this.errorPage, 'error');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(this.stack);
        this.dialog.set_child(toolbar);
        // Closing by Escape or the header button must stop the call too, not just hide it.
        this.dialog.connect('closed', () => {
            this.token.next();
            this.controller?.abort();
        });
    }

    open(parent: Gtk.Widget, hooks: VorschlagHooks): void {
        this.hooks = hooks;
        this.dialog.present(parent);
        this.reload();
    }

    /** Stop the AI call and leave; the token bump drops an answer that arrives anyway. */
    private cancel(): void {
        this.token.next();
        this.controller?.abort();
        this.dialog.close();
    }

    private reload(): void {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        loadIntoStack({
            stack: this.stack,
            errorPage: this.errorPage,
            token: this.token,
            errorContext: _('Could not read the contract data from the document'),
            load: () =>
                loadContractProposal(this.hooks.entity, {
                    documentRef: this.hooks.documentRef,
                    ...(this.hooks.contractId ? { contractId: this.hooks.contractId } : {}),
                    signal: controller.signal,
                }),
            fill: (proposal) => {
                const content = this.buildContent(proposal);
                const existing = this.stack.get_child_by_name('content');
                if (existing) this.stack.remove(existing);
                this.stack.add_named(content, 'content');
            },
        });
    }

    private buildContent(proposal: ContractProposal): Gtk.Widget {
        this.switches = new Map();
        const page = new Adw.PreferencesPage();
        page.add(this.sourceGroup(proposal));
        if (proposal.fields.length > 0) {
            page.add(this.fieldsGroup(proposal));
            page.add(this.applyGroup(proposal));
        }
        return page;
    }

    /** Where the values come from — the document, and the model that read it. */
    private sourceGroup(proposal: ContractProposal): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Source'),
            description: markup(
                _(
                    'Check every value against the passage it was read from — an AI reads a contract, it does not sign it.',
                ),
            ),
        });
        const row = new Adw.ActionRow({ title: _('Document'), subtitle: markup(proposal.documentRef) });
        if (proposal.model) row.add_suffix(badge(proposal.model));
        group.add(row);
        for (const hint of proposal.hints) {
            const hintRow = new Adw.ActionRow({ title: markup(hint) });
            hintRow.set_title_lines(3);
            hintRow.add_prefix(new Gtk.Image({ iconName: 'dialog-information-symbolic', cssClasses: ['warning'] }));
            group.add(hintRow);
        }
        return group;
    }

    /** One switch per field the document states, pre-set to the ones that would really change. */
    private fieldsGroup(proposal: ContractProposal): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('What the document says'),
            description: markup(_('Only the fields switched on are taken over; the others stay as they are.')),
        });
        const labels = PROPOSAL_FIELD_LABEL();
        for (const field of proposal.fields) {
            const row = new Adw.SwitchRow({
                title: labels[field.field],
                subtitle: markup(fieldSubtitle(field)),
                active: field.differs,
            });
            row.set_subtitle_lines(4);
            row.add_prefix(scoreBadge(field.confidence));
            group.add(row);
            this.switches.set(field.field, row);
        }
        return group;
    }

    private applyGroup(proposal: ContractProposal): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup();
        const apply = new Adw.ButtonRow({ title: _('Take over the selected fields') });
        apply.add_css_class('suggested-action');
        apply.connect('activated', () => {
            const accepted = [...this.switches.entries()].filter(([, row]) => row.get_active()).map(([field]) => field);
            this.dialog.close();
            if (accepted.length > 0) this.hooks.onApply(contractInputFromProposal(proposal, accepted));
        });
        group.add(apply);
        return group;
    }
}

/** The value, the value it replaces, and the passage behind both. */
function fieldSubtitle(field: ContractFieldSuggestion): string {
    const proposed = proposalValueText(field.field, field.value);
    const head = field.differs
        ? field.current === undefined
            ? proposed
            : fmt(_('{old} → {new}'), { old: proposalValueText(field.field, field.current), new: proposed })
        : fmt(_('{value} — already recorded that way'), { value: proposed });
    return `${head}\n„${field.snippet}“`;
}

function badge(label: string): Gtk.Label {
    return new Gtk.Label({ label, cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.CENTER });
}
