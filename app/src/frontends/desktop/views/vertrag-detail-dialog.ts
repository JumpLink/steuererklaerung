/**
 * <BhVertragDetailDialog> — one contract (ADR 0004) with everything derived from it: what it costs
 * per month, when notice must be given at the latest, what the account data says about its debits
 * (missing / returned / changed), which bookings are candidates, and which documents belong to it.
 *
 * The native counterpart to `contracts zeigen` + `contracts abgleich`. Nothing is computed here: the
 * figures come from `presenters/contracts.ts`, the wording from `vertrag-labels.ts`, and every write
 * (link a booking, reject it, attach a document, archive) goes through the actions layer and is
 * followed by a fresh read — so the dialog never shows a state the ledger does not hold.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { CONTRACT_DOCUMENT_ROLES, type ContractDocumentRole } from '@steuererklaerung/store';

import type { ContractCandidate } from '../../../core/contracts/contracts.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import {
    archiveContractRecord,
    type ContractDetailView,
    deadlineUrgency,
    decideContractTransaction,
    linkContractDocument,
    loadContractDetail,
} from '../../../core/presenters/contracts.ts';
import { _, _n, fmt } from '../i18n.ts';
import { showToast } from '../toast.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { amountLabel, currentOperator, markup } from './util.ts';
import {
    CYCLE_LABEL,
    deadlineText,
    DOCUMENT_ROLE_LABEL,
    findingCss,
    findingHint,
    findingText,
    MATCH_VIA_LABEL,
    NOTICE_UNIT_LABEL,
    PAYMENT_METHOD_LABEL,
    STATUS_CSS,
    STATUS_LABEL,
    URGENCY_CSS,
} from './vertrag-labels.ts';

export class BhVertragDetailDialog {
    private dialog!: Adw.Dialog;
    private contractId = '';
    private onChanged: () => void = () => {};
    private page: Adw.PreferencesPage | null = null;
    private shownGroups: Adw.PreferencesGroup[] = [];
    /** The role a newly attached document gets; remembered across a rebuild of the groups. */
    private documentRole: ContractDocumentRole = 'contract';

    open(parent: Gtk.Widget, contractId: string, hooks: { onEdit: () => void; onChanged: () => void }): void {
        this.contractId = contractId;
        this.onChanged = hooks.onChanged;
        this.dialog = new Adw.Dialog({ title: _('Contract'), contentWidth: 600, contentHeight: 720 });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const edit = new Gtk.Button({ label: _('Edit') });
        edit.set_tooltip_text(_('Change the contract’s term, amount and notice period'));
        edit.connect('clicked', () => {
            this.dialog.close();
            hooks.onEdit();
        });
        header.pack_start(edit);
        const archive = new Gtk.Button({ label: _('Archive'), cssClasses: ['destructive-action'] });
        archive.set_tooltip_text(_('Take the contract out of the list — its bookings and documents stay'));
        archive.connect('clicked', () => void this.archive());
        header.pack_end(archive);
        toolbar.add_top_bar(header);
        this.page = new Adw.PreferencesPage();
        toolbar.set_content(this.page);
        this.dialog.set_child(toolbar);
        this.dialog.present(parent);
        this.refresh();
    }

    /** Re-read the contract and rebuild the groups — after every write, so nothing shown is stale. */
    private refresh(): void {
        try {
            const view = loadContractDetail(this.contractId);
            if (!view) {
                this.dialog.close();
                return;
            }
            this.render(view);
        } catch (err) {
            void errorDialog(this.dialog, _('Contract could not be loaded'), message(err));
        }
    }

    private render(view: ContractDetailView): void {
        const page = this.page;
        if (!page) return;
        for (const g of this.shownGroups) page.remove(g);
        this.shownGroups = [];
        const add = (g: Adw.PreferencesGroup) => {
            page.add(g);
            this.shownGroups.push(g);
        };
        const c = view.detail.contract;
        this.dialog.set_title(c.name);

        add(this.overviewGroup(view));
        add(this.deadlineGroup(view));
        add(this.findingsGroup(view));
        add(this.candidatesGroup(view));
        add(this.documentsGroup(view));
    }

    private overviewGroup(view: ContractDetailView): Adw.PreferencesGroup {
        const c = view.detail.contract;
        const group = new Adw.PreferencesGroup({ title: _('Contract') });
        group.set_header_suffix(badge(STATUS_LABEL[c.status], STATUS_CSS[c.status]));

        const cost = new Adw.ActionRow({
            title: _('Costs'),
            subtitle: markup(
                c.cycle
                    ? fmt(_('{amount} {cycle}'), { amount: eur(c.amount ?? 0), cycle: CYCLE_LABEL[c.cycle] })
                    : _('no amount recorded'),
            ),
        });
        if (c.monthlyAmount != null) {
            cost.add_suffix(amountLabel(fmt(_('{amount} / month'), { amount: eur(c.monthlyAmount) })));
        }
        group.add(cost);

        const rows: [string, string | null][] = [
            [_('Provider'), c.counterparty],
            [_('Contract number'), c.contractNumber],
            [_('Category'), c.category],
            [_('Paid from'), c.accountKey],
            [_('Payment method'), c.paymentMethod ? PAYMENT_METHOD_LABEL[c.paymentMethod] : null],
            [_('Note'), c.notes],
        ];
        for (const [title, value] of rows) {
            if (!value) continue;
            group.add(new Adw.ActionRow({ title, subtitle: markup(value) }));
        }
        // More than one paying account means the direct debit moved — worth saying, because the
        // weaker match keys only apply to the contract's own account.
        const accounts = view.match?.accounts ?? [];
        if (accounts.length > 1) {
            for (const a of accounts) {
                group.add(
                    new Adw.ActionRow({
                        title: markup(a.accountKey),
                        subtitle: markup(
                            fmt(_('{n} payments · {first} to {last}'), {
                                n: a.payments,
                                first: deDate(a.first),
                                last: deDate(a.last),
                            }),
                        ),
                    }),
                );
            }
        }
        return group;
    }

    private deadlineGroup(view: ContractDetailView): Adw.PreferencesGroup {
        const c = view.detail.contract;
        const group = new Adw.PreferencesGroup({
            title: _('Term and notice period'),
            description: markup(_('Derived from the dates below on every read — never stored.')),
        });
        const deadline = new Adw.ActionRow({ title: _('Notice deadline'), subtitle: markup(deadlineText(c.deadline)) });
        if (c.deadline.kind === 'fixed') {
            deadline.add_suffix(
                badge(
                    fmt(_n('{n} day left', '{n} days left', c.deadline.daysLeft), { n: c.deadline.daysLeft }),
                    URGENCY_CSS[deadlineUrgency(c.deadline)],
                ),
            );
        }
        group.add(deadline);

        const term = [
            c.initialTermMonths != null
                ? fmt(_n('{n} month initial term', '{n} months initial term', c.initialTermMonths), {
                      n: c.initialTermMonths,
                  })
                : null,
            c.renewalMonths != null
                ? fmt(_n('renews by {n} month', 'renews by {n} months', c.renewalMonths), { n: c.renewalMonths })
                : c.autoRenewal
                  ? _('runs indefinitely')
                  : null,
            c.autoRenewal ? null : _('does not renew automatically'),
        ].filter(Boolean);
        const rows: [string, string | null][] = [
            [_('Start'), c.startDate ? deDate(c.startDate) : null],
            [_('Term'), term.length ? term.join(' · ') : null],
            [
                _('Notice period'),
                c.noticeValue != null && c.noticeUnit
                    ? fmt(_('{value} {unit}'), { value: c.noticeValue, unit: NOTICE_UNIT_LABEL[c.noticeUnit] })
                    : null,
            ],
            [_('End'), c.endDate ? deDate(c.endDate) : null],
        ];
        for (const [title, value] of rows) {
            if (!value) continue;
            group.add(new Adw.ActionRow({ title, subtitle: markup(value) }));
        }
        return group;
    }

    private findingsGroup(view: ContractDetailView): Adw.PreferencesGroup {
        const findings = view.match?.findings ?? [];
        const group = new Adw.PreferencesGroup({
            title: _('What the account data says'),
            description: markup(
                view.match?.asOf
                    ? fmt(_('Bookings up to {date}.'), { date: deDate(view.match.asOf) })
                    : _('No bookings imported for this entity yet.'),
            ),
        });
        if (findings.length === 0) {
            group.add(
                new Adw.ActionRow({
                    title: _('Nothing stands out'),
                    subtitle: markup(_('Every expected debit is there and the amount matches.')),
                }),
            );
            return group;
        }
        for (const f of findings) {
            const row = new Adw.ActionRow({ title: markup(findingText(f)), subtitle: markup(findingHint(f) ?? '') });
            row.set_title_lines(2);
            row.add_prefix(new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: [findingCss(f)] }));
            group.add(row);
        }
        return group;
    }

    private candidatesGroup(view: ContractDetailView): Adw.PreferencesGroup {
        const candidates = view.match?.candidates ?? [];
        const rejected = view.detail.transactions.filter((t) => t.status === 'rejected');
        const group = new Adw.PreferencesGroup({
            title: _('Bookings'),
            description: markup(
                _('Debits that match this contract. Linking one is a decision — the matching itself only suggests.'),
            ),
        });
        if (candidates.length === 0) {
            group.add(
                new Adw.ActionRow({
                    title: _('No matching bookings'),
                    subtitle: markup(
                        _('A creditor ID, mandate reference or the provider’s name is what debits are found by.'),
                    ),
                }),
            );
        }
        for (const cand of candidates) group.add(this.candidateRow(cand));
        if (rejected.length > 0) {
            group.add(
                new Adw.ActionRow({
                    title: fmt(
                        _n(
                            '{n} booking marked as not belonging',
                            '{n} bookings marked as not belonging',
                            rejected.length,
                        ),
                        {
                            n: rejected.length,
                        },
                    ),
                    subtitle: markup(_('They are left out of the matching and of the findings.')),
                }),
            );
        }
        return group;
    }

    private candidateRow(cand: ContractCandidate): Adw.ActionRow {
        const sub = [
            deDate(cand.bookingDate),
            fmt(_('via {key}'), { key: MATCH_VIA_LABEL[cand.via] }),
            cand.inAmountWindow ? null : _('amount differs'),
            cand.accountKey,
        ].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(cand.counterparty?.trim() || cand.txId),
            subtitle: markup(sub.join(' · ')),
        });
        row.set_title_lines(1);
        row.add_suffix(amountLabel(eur(cand.amount), { accent: cand.amount < 0 ? 'error' : undefined }));
        if (cand.linked) {
            row.add_suffix(badge(_('linked'), 'success'));
            row.add_suffix(
                this.decideButton(cand, null, _('Unlink'), _('Drop the decision — the booking stays a candidate')),
            );
        } else {
            row.add_suffix(
                this.decideButton(cand, 'linked', _('Link'), _('Record this booking as a payment of the contract')),
            );
            row.add_suffix(
                this.decideButton(
                    cand,
                    'rejected',
                    _('Not this one'),
                    _('Leave this booking out of the contract for good'),
                ),
            );
        }
        return row;
    }

    private decideButton(
        cand: ContractCandidate,
        status: 'linked' | 'rejected' | null,
        label: string,
        tooltip: string,
    ): Gtk.Button {
        const button = new Gtk.Button({ label, valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
        button.set_tooltip_text(`${tooltip}: ${cand.bookingDate}`);
        button.connect('clicked', () => {
            try {
                decideContractTransaction(this.contractId, cand.txId, status, currentOperator());
                showToast(
                    status === 'linked'
                        ? _('Booking linked')
                        : status === 'rejected'
                          ? _('Booking left out')
                          : _('Link removed'),
                );
                this.onChanged();
                this.refresh();
            } catch (err) {
                void errorDialog(this.dialog, _('Could not change the booking'), message(err));
            }
        });
        return button;
    }

    private documentsGroup(view: ContractDetailView): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Documents'),
            description: markup(
                _(
                    'The contract itself, invoices, a notice of termination — referenced in the document store, e.g. paperless:42.',
                ),
            ),
        });
        for (const doc of view.detail.documents) {
            const row = new Adw.ActionRow({
                title: markup(doc.documentRef),
                subtitle: markup(
                    fmt(_('{role} · attached {date}'), {
                        role: DOCUMENT_ROLE_LABEL[doc.role],
                        date: deDate(doc.linkedAt.slice(0, 10)),
                    }),
                ),
            });
            const detach = new Gtk.Button({ label: _('Detach'), valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
            detach.set_tooltip_text(fmt(_('Detach document {ref} from the contract'), { ref: doc.documentRef }));
            detach.connect('clicked', () => this.linkDocument(doc.documentRef, null));
            row.add_suffix(detach);
            group.add(row);
        }

        const roleRow = new Adw.ComboRow({
            title: _('Role of the next document'),
            model: Gtk.StringList.new(CONTRACT_DOCUMENT_ROLES.map((r) => DOCUMENT_ROLE_LABEL[r])),
        });
        roleRow.set_selected(Math.max(0, CONTRACT_DOCUMENT_ROLES.indexOf(this.documentRole)));
        roleRow.connect('notify::selected', () => {
            this.documentRole = CONTRACT_DOCUMENT_ROLES[roleRow.get_selected()] ?? 'contract';
        });
        group.add(roleRow);

        const refRow = new Adw.EntryRow({ title: _('Attach document (reference)'), showApplyButton: true });
        refRow.connect('apply', () => {
            const ref = refRow.get_text()?.trim() ?? '';
            if (!ref) return;
            this.linkDocument(ref, this.documentRole);
        });
        group.add(refRow);
        return group;
    }

    private linkDocument(ref: string, role: ContractDocumentRole | null): void {
        try {
            linkContractDocument(this.contractId, ref, role);
            showToast(role ? _('Document attached') : _('Document detached'));
            this.onChanged();
            this.refresh();
        } catch (err) {
            void errorDialog(this.dialog, _('Could not change the documents'), message(err));
        }
    }

    private async archive(): Promise<void> {
        const ok = await confirmDialog(this.dialog, {
            heading: _('Archive contract?'),
            body: _(
                'It leaves the list but stays readable under the “Archived” filter, with its bookings and documents.',
            ),
            confirmLabel: _('Archive'),
            destructive: true,
        });
        if (!ok) return;
        try {
            archiveContractRecord(this.contractId);
            showToast(_('Contract archived'));
            this.onChanged();
            this.dialog.close();
        } catch (err) {
            await errorDialog(this.dialog, _('Could not archive'), message(err));
        }
    }
}

function badge(label: string, css: string): Gtk.Label {
    return new Gtk.Label({ label, cssClasses: ['caption', css], valign: Gtk.Align.CENTER });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
