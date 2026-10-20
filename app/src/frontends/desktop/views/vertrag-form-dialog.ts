/**
 * <BhVertragFormDialog> — create / edit a contract (ADR 0004), the native counterpart to
 * `contracts speichern`.
 *
 * An Adw.PreferencesDialog with every writable field of the contract record, in the order someone
 * fills them: what the contract IS, what it COSTS, how long it RUNS, and — last, because it is
 * machinery rather than contract content — what identifies its debits on a bank statement.
 *
 * No rules of its own: the empty-vs-unparseable distinction is the only thing decided here (an empty
 * field CLEARS the value, an unreadable one is refused), and the save goes through
 * `saveContractRecord`, so the same validation as the CLI and the MCP tool applies.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    CONTRACT_CYCLES,
    CONTRACT_PAYMENT_METHODS,
    CONTRACT_STATUSES,
    type ContractInput,
    NOTICE_UNITS,
} from '@steuererklaerung/store';

import { parseGermanInput } from '../../../core/lib/parsing.ts';
import { contractAccountKeys, type ContractSummary, saveContractRecord } from '../../../core/presenters/contracts.ts';
import { contractExtractionAvailable } from '../data/contract-extract.ts';
import type { AppEntity } from '../entities.ts';
import { _, fmt } from '../i18n.ts';
import { errorText } from '../error-text.ts';
import { showToast } from '../toast.ts';
import { errorDialog } from './dialogs.ts';
import { CYCLE_LABEL, NOTICE_UNIT_LABEL, PAYMENT_METHOD_LABEL, STATUS_LABEL } from './vertrag-labels.ts';
import { BhVertragVorschlagDialog } from './vertrag-vorschlag-dialog.ts';

/** `undefined` = the field could not be read; `null` = it was left empty, which clears the value. */
type Parsed<T> = T | null | undefined;

/** The combo entry standing for "not stated" — index 0 of every optional enum picker. */
const UNSET = () => _('(not stated)');

export class BhVertragFormDialog {
    private readonly dialog = new Adw.PreferencesDialog();
    private entity!: AppEntity;
    private existing: ContractSummary | null = null;
    private onSaved: () => void = () => {};
    /** The account keys offered, in combo order after the leading "(not stated)". */
    private accounts: string[] = [];

    private nameRow!: Adw.EntryRow;
    private counterpartyRow!: Adw.EntryRow;
    private contractNumberRow!: Adw.EntryRow;
    private categoryRow!: Adw.EntryRow;
    private statusRow!: Adw.ComboRow;
    private notesRow!: Adw.EntryRow;

    private amountRow!: Adw.EntryRow;
    private cycleRow!: Adw.ComboRow;
    private toleranceRow!: Adw.EntryRow;
    private accountRow!: Adw.ComboRow;
    private paymentMethodRow!: Adw.ComboRow;

    private startDateRow!: Adw.EntryRow;
    private initialTermRow!: Adw.EntryRow;
    private autoRenewalRow!: Adw.SwitchRow;
    private renewalRow!: Adw.EntryRow;
    private noticeValueRow!: Adw.EntryRow;
    private noticeUnitRow!: Adw.ComboRow;
    private endDateRow!: Adw.EntryRow;

    private creditorIdRow!: Adw.EntryRow;
    private mandateRow!: Adw.EntryRow;
    private ibanRow!: Adw.EntryRow;
    private matchTextRow!: Adw.EntryRow;
    private counterpartyRefRow!: Adw.EntryRow;

    private saveButton!: Adw.ButtonRow;

    open(parent: Gtk.Widget, entity: AppEntity, existing: ContractSummary | null, onSaved: () => void): void {
        this.entity = entity;
        this.existing = existing;
        this.onSaved = onSaved;
        // The contract's own account stays offered even when it no longer belongs to the entity —
        // otherwise opening the form would silently re-point the contract at another account.
        const keys = contractAccountKeys(entity.id);
        const own = existing?.accountKey;
        this.accounts = own && !keys.includes(own) ? [own, ...keys] : keys;
        this.build(parent);
    }

    private build(parent: Gtk.Widget): void {
        const c = this.existing;
        this.dialog.set_title(c ? _('Edit contract') : _('New contract'));
        const page = new Adw.PreferencesPage();

        if (contractExtractionAvailable()) page.add(this.buildExtractGroup());
        page.add(this.buildContractGroup(c));
        page.add(this.buildPaymentGroup(c));
        page.add(this.buildTermGroup(c));
        page.add(this.buildMatchingGroup(c));

        const actions = new Adw.PreferencesGroup();
        this.saveButton = new Adw.ButtonRow({ title: _('Save') });
        this.saveButton.add_css_class('suggested-action');
        this.saveButton.connect('activated', () => void this.save());
        actions.add(this.saveButton);
        page.add(actions);

        this.dialog.add(page);
        this.dialog.present(parent);
    }

    /**
     * Fill the form from a document instead of typing it. The reading only pre-fills these rows —
     * nothing is written until Save, which is also why a contract that does not exist yet can be
     * started this way.
     */
    private buildExtractGroup(): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Take the data from a document'),
            description: _(
                'Reads term, notice period and price off a document in the document store and offers them field by field. Only Save writes anything.',
            ),
        });
        const row = new Adw.EntryRow({ title: _('Document (reference)'), showApplyButton: true });
        row.set_tooltip_text(_('The reference in the document store, e.g. paperless:42.'));
        row.connect('apply', () => {
            const ref = row.get_text()?.trim() ?? '';
            if (!ref) return;
            new BhVertragVorschlagDialog().open(this.dialog, {
                entity: this.entity,
                documentRef: ref,
                ...(this.existing ? { contractId: this.existing.id } : {}),
                onApply: (input) => this.applyToRows(input),
            });
        });
        group.add(row);
        return group;
    }

    /** The accepted fields into the form rows — the one place the proposal touches this dialog. */
    private applyToRows(input: ContractInput): void {
        const setText = (row: Adw.EntryRow, value: string | null | undefined) => {
            if (value != null) row.set_text(value);
        };
        const setNumber = (row: Adw.EntryRow, value: number | null | undefined) => {
            if (value != null) row.set_text(String(value));
        };
        setText(this.counterpartyRow, input.counterparty);
        setText(this.contractNumberRow, input.contractNumber);
        setText(this.startDateRow, input.startDate);
        setNumber(this.amountRow, input.amount);
        setNumber(this.initialTermRow, input.initialTermMonths);
        setNumber(this.renewalRow, input.renewalMonths);
        setNumber(this.noticeValueRow, input.noticeValue);
        if (input.cycle != null) this.cycleRow.set_selected(indexOfOptional(CONTRACT_CYCLES, input.cycle));
        if (input.noticeUnit != null) this.noticeUnitRow.set_selected(indexOfOptional(NOTICE_UNITS, input.noticeUnit));
        if (input.autoRenewal != null) this.autoRenewalRow.set_active(input.autoRenewal);
        // The name is the one required field and not something a contract document states reliably —
        // offer the provider for it rather than leaving the form unsavable.
        if (!(this.nameRow.get_text()?.trim() ?? '') && input.counterparty) this.nameRow.set_text(input.counterparty);
        showToast(_('Fields filled in — check them and save'));
    }

    private buildContractGroup(c: ContractSummary | null): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: _('Contract') });
        this.nameRow = new Adw.EntryRow({ title: _('Name'), text: c?.name ?? '' });
        this.counterpartyRow = new Adw.EntryRow({
            title: _('Provider'),
            text: c?.counterparty ?? '',
        });
        this.counterpartyRow.set_tooltip_text(_('As it appears on bank statements — that is how debits are matched.'));
        this.contractNumberRow = new Adw.EntryRow({ title: _('Contract number'), text: c?.contractNumber ?? '' });
        this.categoryRow = new Adw.EntryRow({ title: _('Category'), text: c?.category ?? '' });
        this.statusRow = this.enumRow(
            _('Status'),
            CONTRACT_STATUSES.map((s) => STATUS_LABEL[s]),
            [...CONTRACT_STATUSES].indexOf(c?.status ?? 'active'),
            false,
        );
        this.notesRow = new Adw.EntryRow({ title: _('Note'), text: c?.notes ?? '' });
        for (const row of [
            this.nameRow,
            this.counterpartyRow,
            this.contractNumberRow,
            this.categoryRow,
            this.statusRow,
            this.notesRow,
        ]) {
            group.add(row);
        }
        return group;
    }

    private buildPaymentGroup(c: ContractSummary | null): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Payment'),
            description: _('What it costs and how often. The monthly figure in the list is derived from these two.'),
        });
        this.amountRow = new Adw.EntryRow({ title: _('Amount (€)'), text: numberText(c?.amount) });
        this.cycleRow = this.enumRow(
            _('Interval'),
            CONTRACT_CYCLES.map((x) => CYCLE_LABEL[x]),
            indexOfOptional(CONTRACT_CYCLES, c?.cycle),
            true,
        );
        this.toleranceRow = new Adw.EntryRow({
            title: _('Tolerance (€)'),
            text: numberText(c?.amountTolerance),
        });
        this.toleranceRow.set_tooltip_text(
            _('How far a debit may differ from the amount and still count as the expected payment.'),
        );
        this.accountRow = this.enumRow(
            _('Paid from'),
            this.accounts,
            indexOfOptional(this.accounts, c?.accountKey),
            true,
        );
        if (this.accounts.length === 0) this.accountRow.set_subtitle(_('No accounts imported yet'));
        this.paymentMethodRow = this.enumRow(
            _('Payment method'),
            CONTRACT_PAYMENT_METHODS.map((m) => PAYMENT_METHOD_LABEL[m]),
            indexOfOptional(CONTRACT_PAYMENT_METHODS, c?.paymentMethod),
            true,
        );
        for (const row of [this.amountRow, this.cycleRow, this.toleranceRow, this.accountRow, this.paymentMethodRow]) {
            group.add(row);
        }
        return group;
    }

    private buildTermGroup(c: ContractSummary | null): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Term and notice period'),
            description: _(
                'The notice deadline is derived from these, never stored — a start date and a notice period are what it takes.',
            ),
        });
        this.startDateRow = new Adw.EntryRow({ title: _('Start (YYYY-MM-DD)'), text: c?.startDate ?? '' });
        this.initialTermRow = new Adw.EntryRow({
            title: _('Initial term (months)'),
            text: numberText(c?.initialTermMonths),
        });
        this.autoRenewalRow = new Adw.SwitchRow({
            title: _('Renews automatically'),
            subtitle: _('Off: the contract ends with its term, with no notice needed.'),
            active: c?.autoRenewal ?? true,
        });
        this.renewalRow = new Adw.EntryRow({
            title: _('Renewal (months)'),
            text: numberText(c?.renewalMonths),
        });
        this.renewalRow.set_tooltip_text(_('Empty: it runs indefinitely and can be cancelled at any time.'));
        this.noticeValueRow = new Adw.EntryRow({ title: _('Notice period'), text: numberText(c?.noticeValue) });
        this.noticeUnitRow = this.enumRow(
            _('Notice period unit'),
            NOTICE_UNITS.map((u) => NOTICE_UNIT_LABEL[u]),
            indexOfOptional(NOTICE_UNITS, c?.noticeUnit),
            true,
        );
        this.endDateRow = new Adw.EntryRow({ title: _('End (YYYY-MM-DD)'), text: c?.endDate ?? '' });
        this.endDateRow.set_tooltip_text(_('Set once the end is known — after giving notice or for a fixed term.'));
        for (const row of [
            this.startDateRow,
            this.initialTermRow,
            this.autoRenewalRow,
            this.renewalRow,
            this.noticeValueRow,
            this.noticeUnitRow,
            this.endDateRow,
        ]) {
            group.add(row);
        }
        return group;
    }

    private buildMatchingGroup(c: ContractSummary | null): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Recognising the debits'),
            description: _(
                'Which bookings belong to this contract. A creditor ID or mandate reference is the strongest match and holds even when the debit moves to another account.',
            ),
        });
        this.creditorIdRow = new Adw.EntryRow({ title: _('SEPA creditor ID'), text: c?.creditorId ?? '' });
        this.mandateRow = new Adw.EntryRow({ title: _('Mandate reference'), text: c?.mandateReference ?? '' });
        this.ibanRow = new Adw.EntryRow({ title: _('Provider IBAN'), text: c?.counterpartyIban ?? '' });
        this.matchTextRow = new Adw.EntryRow({ title: _('Extra text to match'), text: c?.matchText ?? '' });
        this.counterpartyRefRow = new Adw.EntryRow({
            title: _('DMS correspondent'),
            text: c?.counterpartyRef ?? '',
        });
        this.counterpartyRefRow.set_tooltip_text(
            _('The reference of the sender in the document store, e.g. paperless:42.'),
        );
        for (const row of [
            this.creditorIdRow,
            this.mandateRow,
            this.ibanRow,
            this.matchTextRow,
            this.counterpartyRefRow,
        ]) {
            group.add(row);
        }
        return group;
    }

    /**
     * A combo over a fixed list of labels. `optional` prepends "(not stated)", so index 0 means the
     * field is cleared and the stored enums keep their own indices behind it.
     */
    private enumRow(title: string, labels: readonly string[], selected: number, optional: boolean): Adw.ComboRow {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(optional ? [UNSET(), ...labels] : [...labels]),
        });
        row.set_selected(Math.max(0, selected));
        return row;
    }

    private async save(): Promise<void> {
        const text = (row: Adw.EntryRow): string => row.get_text()?.trim() ?? '';
        const name = text(this.nameRow);
        if (!name) return void (await this.fail(_('The contract needs a name.')));

        const numbers: Record<string, Parsed<number>> = {
            amount: money(text(this.amountRow)),
            amountTolerance: money(text(this.toleranceRow)),
            initialTermMonths: wholeNumber(text(this.initialTermRow)),
            renewalMonths: wholeNumber(text(this.renewalRow)),
            noticeValue: wholeNumber(text(this.noticeValueRow)),
        };
        const bad = Object.entries(numbers).find(([, v]) => v === undefined);
        if (bad)
            return void (await this.fail(
                fmt(_('“{field}” is not a number.'), { field: FIELD_LABEL()[bad[0]] ?? bad[0] }),
            ));

        // A notice period is value AND unit — half of it derives no deadline at all, so the form says
        // so rather than saving something that silently shows "no notice period".
        const noticeValue = numbers.noticeValue ?? null;
        const noticeUnit = pick(NOTICE_UNITS, this.noticeUnitRow);
        if ((noticeValue == null) !== (noticeUnit == null)) {
            return void (await this.fail(_('A notice period needs both a number and a unit.')));
        }

        const input: ContractInput = {
            ...(this.existing ? { id: this.existing.id } : {}),
            entityId: this.entity.id,
            name,
            counterparty: text(this.counterpartyRow) || null,
            counterpartyRef: text(this.counterpartyRefRow) || null,
            contractNumber: text(this.contractNumberRow) || null,
            accountKey: this.accounts[this.accountRow.get_selected() - 1] ?? null,
            category: text(this.categoryRow) || null,
            amount: numbers.amount ?? null,
            cycle: pick(CONTRACT_CYCLES, this.cycleRow),
            amountTolerance: numbers.amountTolerance ?? null,
            startDate: text(this.startDateRow) || null,
            initialTermMonths: numbers.initialTermMonths ?? null,
            renewalMonths: numbers.renewalMonths ?? null,
            noticeValue,
            noticeUnit,
            autoRenewal: this.autoRenewalRow.get_active(),
            endDate: text(this.endDateRow) || null,
            paymentMethod: pick(CONTRACT_PAYMENT_METHODS, this.paymentMethodRow),
            creditorId: text(this.creditorIdRow) || null,
            mandateReference: text(this.mandateRow) || null,
            counterpartyIban: text(this.ibanRow) || null,
            matchText: text(this.matchTextRow) || null,
            status: CONTRACT_STATUSES[this.statusRow.get_selected()] ?? 'active',
            notes: text(this.notesRow) || null,
        };

        this.saveButton.set_sensitive(false);
        this.saveButton.set_title(_('Saving …'));
        try {
            saveContractRecord(input);
            this.dialog.close();
            showToast(this.existing ? _('Contract updated') : _('Contract created'));
            this.onSaved();
        } catch (err) {
            this.saveButton.set_sensitive(true);
            this.saveButton.set_title(_('Save'));
            await this.fail(errorText(err));
        }
    }

    private fail(message: string): Promise<void> {
        return errorDialog(this.dialog, _('Could not save'), message);
    }
}

/** The numeric fields by name, for the "not a number" message. Built on call so it is translated. */
function FIELD_LABEL(): Record<string, string> {
    return {
        amount: _('Amount (€)'),
        amountTolerance: _('Tolerance (€)'),
        initialTermMonths: _('Initial term (months)'),
        renewalMonths: _('Renewal (months)'),
        noticeValue: _('Notice period'),
    };
}

/** What an existing value looks like in an entry row: the plain number, or nothing. */
function numberText(value: number | null | undefined): string {
    return value == null ? '' : String(value);
}

/** `1.234,56` and `1234.56`; empty clears the value, unreadable is refused by the caller. */
function money(text: string): Parsed<number> {
    if (text === '') return null;
    return parseGermanInput(text) ?? undefined;
}

/** A count of months or days: whole and not negative, else refused. */
function wholeNumber(text: string): Parsed<number> {
    if (text === '') return null;
    const n = parseGermanInput(text);
    if (n == null || !Number.isInteger(n) || n < 0) return undefined;
    return n;
}

/** The index of `value` in `list` shifted by the leading "(not stated)"; 0 when absent. */
function indexOfOptional<T>(list: readonly T[], value: T | null | undefined): number {
    if (value == null) return 0;
    const i = list.indexOf(value);
    return i < 0 ? 0 : i + 1;
}

/** The enum value a combo with a leading "(not stated)" selects; null for that first entry. */
function pick<T>(list: readonly T[], row: Adw.ComboRow): T | null {
    return list[row.get_selected() - 1] ?? null;
}
