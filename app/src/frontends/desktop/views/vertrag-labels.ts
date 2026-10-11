/**
 * How a contract (ADR 0004) is WORDED in the native app — the enum labels, the notice deadline and
 * the findings, each as the one line a row has room for.
 *
 * Shared by the list view, the form and the detail dialog so the three cannot word the same finding
 * differently. The wording mirrors the CLI's `fristText` / `findingText` (`frontends/cli/contracts.ts`)
 * but goes through gettext, which the CLI does not. Nothing is derived here that the core derives —
 * the rules stay in `core/contracts/contracts.ts`, this file only names their outcome.
 */

import {
    type ContractCycle,
    type ContractDocumentRole,
    type ContractPaymentMethod,
    type ContractStatus,
    type NoticeUnit,
} from '@steuererklaerung/store';

import type { MatchVia } from '../../../core/contracts/contracts.ts';

import type { ContractFinding, NoticeDeadline } from '../../../core/presenters/contracts.ts';
import type { DeadlineUrgency } from '../../../core/presenters/contracts.ts';
import { deDate } from '../../../core/lib/format.ts';
import { fmtDe } from '../../../core/lib/money.ts';
import { _, _n, _p, fmt } from '../i18n.ts';

export const CYCLE_LABEL: Record<ContractCycle, string> = {
    monatlich: _p('payment interval', 'monthly'),
    vierteljaehrlich: _p('payment interval', 'quarterly'),
    halbjaehrlich: _p('payment interval', 'half-yearly'),
    jaehrlich: _p('payment interval', 'yearly'),
};

export const NOTICE_UNIT_LABEL: Record<NoticeUnit, string> = {
    days: _p('notice period unit', 'days'),
    weeks: _p('notice period unit', 'weeks'),
    months: _p('notice period unit', 'months'),
};

export const PAYMENT_METHOD_LABEL: Record<ContractPaymentMethod, string> = {
    lastschrift: _p('payment method', 'Direct debit'),
    ueberweisung: _p('payment method', 'Bank transfer'),
    karte: _p('payment method', 'Card'),
    paypal: _p('payment method', 'PayPal'),
    sonstiges: _p('payment method', 'Other'),
};

export const STATUS_LABEL: Record<ContractStatus, string> = {
    active: _p('contract status', 'Active'),
    cancelled: _p('contract status', 'Cancelled'),
    ended: _p('contract status', 'Ended'),
    archived: _p('contract status', 'Archived'),
};

/** GTK css class per status — a cancelled contract still runs, so it is a warning, not an error. */
export const STATUS_CSS: Record<ContractStatus, string> = {
    active: 'success',
    cancelled: 'warning',
    ended: 'dim-label',
    archived: 'dim-label',
};

/** Why a booking is a candidate — the detail dialog says it, so a wrong match can be told apart. */
export const MATCH_VIA_LABEL: Record<MatchVia, string> = {
    creditor_id: _p('booking matched by', 'creditor ID'),
    mandate_reference: _p('booking matched by', 'mandate reference'),
    contract_number: _p('booking matched by', 'contract number'),
    iban: _p('booking matched by', 'IBAN'),
    name: _p('booking matched by', 'provider name'),
    text: _p('booking matched by', 'matching text'),
};

export const DOCUMENT_ROLE_LABEL: Record<ContractDocumentRole, string> = {
    contract: _p('document role', 'Contract'),
    invoice: _p('document role', 'Invoice'),
    notice: _p('document role', 'Notice of termination'),
    confirmation: _p('document role', 'Confirmation'),
    other: _p('document role', 'Other'),
};

/** GTK css class for the deadline badge; `later` is deliberately unaccented. */
export const URGENCY_CSS: Record<DeadlineUrgency, string> = {
    urgent: 'error',
    soon: 'warning',
    later: 'dim-label',
    none: 'dim-label',
};

/** The full deadline sentence — what the detail dialog and the row subtitle say. */
export function deadlineText(d: NoticeDeadline): string {
    if (d.kind === 'fixed') {
        return fmt(_('give notice by {date} → ends {end}'), {
            date: deDate(d.latestNotice),
            end: deDate(d.termEnd),
        });
    }
    if (d.kind === 'anytime') {
        return fmt(_('cancellable any time, earliest on {date}'), { date: deDate(d.termEnd) });
    }
    // The core words WHY there is no deadline ("gekündigt, endet …", "keine Kündigungsfrist") and it
    // words it in German. Shown as it comes rather than re-deriving the branching here — see the
    // follow-up noted in ADR 0004.
    return d.reason;
}

/** The short badge beside a row: how much time is left. Empty string = no badge. */
export function deadlineBadge(d: NoticeDeadline): string {
    if (d.kind === 'fixed') return fmt(_n('{n} day left', '{n} days left', d.daysLeft), { n: d.daysLeft });
    if (d.kind === 'anytime') return _('any time');
    return '';
}

/** One finding as a single line. */
export function findingText(f: ContractFinding): string {
    if (f.kind === 'missing') {
        return f.expectedAmount == null
            ? fmt(_('{date}: payment missing'), { date: deDate(f.expectedDate) })
            : fmt(_('{date}: payment of {amount} € missing'), {
                  date: deDate(f.expectedDate),
                  amount: fmtDe(f.expectedAmount),
              });
    }
    if (f.kind === 'returned') {
        return fmt(_('{date}: {amount} € returned'), { date: deDate(f.date), amount: fmtDe(f.amount) });
    }
    if (f.kind === 'no_data') {
        return fmt(_('no account data since {date} — refresh the import'), { date: deDate(f.since) });
    }
    return fmt(_('{date}: amount changed to {amount} € instead of {expected} €'), {
        date: deDate(f.date),
        amount: fmtDe(Math.abs(f.amount)),
        expected: fmtDe(f.expectedAmount),
    });
}

/**
 * The extra sentence a finding earns, or null. Derived from `direction` rather than from the core's
 * `hint`, which is a fixed German string — the condition is the same one (the core sets the hint on
 * an increase and only there).
 */
export function findingHint(f: ContractFinding): string | null {
    if (f.kind !== 'changed' || f.direction !== 'increase') return null;
    return _('A price increase can open a special right to cancel — check the provider’s notice and its deadline.');
}

/** GTK css class per finding kind: a missing or returned payment costs money, the rest informs. */
export function findingCss(f: ContractFinding): string {
    return f.kind === 'missing' || f.kind === 'returned' ? 'error' : 'warning';
}
