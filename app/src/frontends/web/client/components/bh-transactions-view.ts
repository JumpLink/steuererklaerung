// <bh-transactions-view> — every bank transaction joined with its classification
// (EÜR category/source) and its linked Paperless receipt, plus the reconciliation
// summary. Read-only. Responsive: dense grid on desktop, stacked rows on mobile.

import { api, type TxRow, type Meta, type TransactionsResponse } from '../lib/api.ts';
import { eur, deDate, esc } from '../lib/format.ts';
import { SOURCE_LABEL, aufgabeCoverage, isVstNoBeleg, openTxDetail } from '../lib/view-helpers.ts';

type Filter = 'all' | 'income' | 'expense' | 'unclassified' | 'vstNoBeleg' | 'aufgabe';
const FILTER_LABEL: Record<Filter, string> = {
    all: 'Alle',
    income: 'Einnahmen',
    expense: 'Ausgaben',
    unclassified: 'Unklassifiziert',
    vstNoBeleg: 'Vorsteuer o. Beleg',
    aufgabe: '§24 nachträglich',
};
/** Post-Betriebsaufgabe rows (kept as GbR §24 or excluded) — a full TxRow + `included`. */
type AufgabeRow = TransactionsResponse['aufgabe'][number];

export class BhTransactionsView extends HTMLElement {
    private meta: Meta | null = null;
    private rows: TxRow[] = [];
    private aufgabe: AufgabeRow[] = [];
    private filter: Filter = 'all';
    /** Account filter: 'all' or a concrete accountKey (camt:… / qonto:… / adjustment). */
    private account = 'all';

    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Transaktionen ${year}…</div>`;
        try {
            const [meta, tx] = await Promise.all([api.meta().catch(() => null), api.transactions(entity, year)]);
            this.meta = meta;
            this.rows = tx.rows;
            this.aufgabe = tx.aufgabe ?? [];
            this.render(year, tx);
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    private render(year: number, tx: Awaited<ReturnType<typeof api.transactions>>) {
        const t = tx.totals;
        // Design: the view leads with a KPI-card row (Buchungen count · Einnahmen · Ausgaben ·
        // Saldo), reusing the home KPI card markup. The net figures come from the EÜR aggregate
        // (tx.totals) — the same numbers the header shows — the count from the table's rows.
        const kpiRow = `
        <div class="bh-kpi-grid">
          <div class="bh-kpi"><div class="bh-kpi-l">Buchungen ${year}</div><div class="bh-kpi-n">${esc(this.rows.length)}</div></div>
          <div class="bh-kpi"><div class="bh-kpi-l">Einnahmen</div><div class="bh-kpi-n pos">${eur(t.incomeNet)}</div><div class="bh-kpi-s">netto ${year}</div></div>
          <div class="bh-kpi"><div class="bh-kpi-l">Ausgaben</div><div class="bh-kpi-n neg">${eur(t.expenseNet)}</div><div class="bh-kpi-s">netto ${year}</div></div>
          <div class="bh-kpi"><div class="bh-kpi-l">Saldo</div><div class="bh-kpi-n ${t.profit >= 0 ? 'pos' : 'neg'}">${eur(t.profit)}</div></div>
        </div>`;
        // Betriebsaufgabe: post-cutoff items are split — GbR §24 (kept, GewSt-free) vs
        // successor/JumpLink (excluded). Both are off the laufende list below.
        const { kept, excluded, keptInc, keptExp } = aufgabeCoverage(tx.coverage.outsidePeriod ?? []);
        const hasAufgabe = kept.length > 0 || excluded.length > 0;
        // Audit-relevant Beleg gap: Vorsteuer claimed without a linked invoice.
        const vstGap = this.rows.filter(isVstNoBeleg);
        const vstSum = vstGap.reduce((s, r) => s + Math.abs(r.vat), 0);
        const unclassifiedN = tx.coverage.unclassified.length;

        // One quiet status line (dot-items) instead of three stacked banners; the longer
        // explanations move into an inline "Details" expander.
        const statusItems = [
            unclassifiedN
                ? `<span class="bh-status warn"><b>${unclassifiedN}</b> unklassifiziert</span>`
                : `<span class="bh-status">0 unklassifiziert</span>`,
            vstGap.length
                ? `<span class="bh-status warn">Vorsteuer o. Beleg <b>${eur(vstSum)}</b> (${vstGap.length})</span>`
                : `<span class="bh-status">Belege vollständig</span>`,
            hasAufgabe ? `<span class="bh-status info">§24 nachträglich <b>${eur(keptInc - keptExp)}</b></span>` : '',
        ]
            .filter(Boolean)
            .join('');
        const detailParas = [
            unclassifiedN ? `<p>⚠ ${unclassifiedN} unklassifizierte Buchung(en) — brauchen Beleg oder Regel.</p>` : '',
            hasAufgabe
                ? `<p>Laufender Teil bis zur Aufgabe <strong>${esc(tx.coverage.activeTo)}</strong>. ${kept.length} nachträgliche GbR-§24-Posten (im Ergebnis, gewerbesteuerfrei): Einnahmen ${eur(keptInc)} − Ausgaben ${eur(keptExp)} = ${eur(keptInc - keptExp)}${excluded.length ? ` · ${excluded.length} Buchung(en) als JumpLink/Nachfolger ausgeschlossen` : ''}.</p>`
                : '',
            vstGap.length
                ? `<p>Vorsteuer ohne verknüpften Beleg: <strong>${eur(vstSum)}</strong> in ${vstGap.length} Buchungen — Rechnungen für die Prüfung bereithalten (nicht an ELSTER zu übermitteln).</p>`
                : '',
        ]
            .filter(Boolean)
            .join('');
        const moreToggle = detailParas
            ? `<details class="bh-statusmore"><summary>Details</summary><div class="bh-statusdetail">${detailParas}</div></details>`
            : '';
        const statusLine = `<div class="bh-statusline">${statusItems}${moreToggle}</div>`;

        // Distinct accounts present (laufende + §24), for the account filter on multi-account entities.
        const accounts = [
            ...new Map([...this.rows, ...this.aufgabe].map((r) => [r.accountKey, r.account])).entries(),
        ].sort((a, b) => a[1].localeCompare(b[1]));
        const accountFilter =
            accounts.length > 1
                ? `<select class="bh-select bh-acct-filter" data-el="account" aria-label="Nach Konto filtern">
            <option value="all">Alle Konten</option>
            ${accounts.map(([k, label]) => `<option value="${esc(k)}"${k === this.account ? ' selected' : ''}>${esc(label)}</option>`).join('')}
          </select>`
                : '';
        // The §24-nachträglich chip only appears when there are post-Betriebsaufgabe items.
        const chips: Filter[] = ['all', 'income', 'expense', 'unclassified', 'vstNoBeleg'];
        if (hasAufgabe) chips.push('aufgabe');

        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result">Gewinn netto <strong>${eur(t.profit)}</strong> <bh-help term="gewinn"></bh-help> · USt-Zahllast ${eur(t.vatPayable)} <bh-help term="ust-zahllast"></bh-help></div>
      </header>
      ${kpiRow}
      ${statusLine}
      <div class="bh-filters" role="tablist">
        ${chips
            .map(
                (f) =>
                    `<button class="bh-chip${f === this.filter ? ' selected' : ''}" data-f="${f}">${esc(FILTER_LABEL[f])}</button>`,
            )
            .join('')}
        ${accountFilter}
      </div>
      <div class="bh-table" role="table">
        <div class="bh-tr bh-thead" role="row">
          <span>Datum</span><span>Gegenseite</span><span class="bh-r">Betrag</span>
          <span>Kategorie</span><span>Quelle</span><span>Beleg</span>
        </div>
        <div class="bh-tbody">${this.renderRows()}</div>
      </div>`;

        const rerenderBody = () => {
            const body = this.querySelector('.bh-tbody');
            if (body) body.innerHTML = this.renderRows();
        };
        this.querySelectorAll('.bh-chip').forEach((b) =>
            b.addEventListener('click', () => {
                this.filter = (b as HTMLElement).dataset.f as typeof this.filter;
                this.querySelectorAll('.bh-chip').forEach((x) => x.classList.toggle('selected', x === b));
                rerenderBody();
            }),
        );
        const acctSel = this.querySelector('[data-el="account"]') as HTMLSelectElement | null;
        acctSel?.addEventListener('change', () => {
            this.account = acctSel.value;
            rerenderBody();
        });

        // Row click → open the full transaction detail. Delegated on the persistent table
        // so it survives the tbody re-render on filter change.
        this.querySelector('.bh-table')?.addEventListener('click', (e) => {
            const id = ((e.target as HTMLElement).closest('.bh-tr[data-id]') as HTMLElement | null)?.dataset.id;
            const row = id ? (this.rows.find((r) => r.id === id) ?? this.aufgabe.find((r) => r.id === id)) : undefined;
            if (row) openTxDetail(row, this.meta?.paperlessUrl ?? null);
        });
    }

    private renderRows(): string {
        const base = this.meta?.paperlessUrl ?? null;
        if (this.filter === 'aufgabe') {
            const items = this.aufgabe.filter((o) => this.account === 'all' || o.accountKey === this.account);
            if (!items.length) return `<div class="bh-empty">Keine nachträglichen Posten.</div>`;
            return items
                .map((o) =>
                    this.renderRow(
                        o,
                        base,
                        o.included
                            ? '<span class="bh-tag s24">§24 nachträglich</span>'
                            : '<span class="bh-tag excl">ausgeschlossen</span>',
                    ),
                )
                .join('');
        }
        const rows = this.rows.filter((r) => {
            if (this.account !== 'all' && r.accountKey !== this.account) return false;
            if (this.filter === 'income') return r.kind === 'income';
            if (this.filter === 'expense') return r.kind === 'expense';
            if (this.filter === 'unclassified') return r.source === 'unclassified';
            if (this.filter === 'vstNoBeleg') return isVstNoBeleg(r);
            return true;
        });
        if (!rows.length) return `<div class="bh-empty">Keine Buchungen.</div>`;
        // Render the two legs of an internal transfer back-to-back (out-leg then in-leg),
        // so a ±0 Umbuchung reads as one block instead of two rows scattered by date.
        const emitted = new Set<string>();
        const html: string[] = [];
        for (const r of rows) {
            if (r.transfer) {
                if (emitted.has(r.transfer.groupId)) continue;
                emitted.add(r.transfer.groupId);
                const legs = rows
                    .filter((x) => x.transfer?.groupId === r.transfer?.groupId)
                    .sort((a, b) => a.amount - b.amount);
                for (const leg of legs) html.push(this.renderRow(leg, base));
                continue;
            }
            html.push(this.renderRow(r, base));
        }
        return html.join('');
    }

    private renderRow(r: TxRow, base: string | null, extraTag = ''): string {
        const amtCls = r.amount < 0 ? 'neg' : 'pos';
        const cat = r.category === '(unklassifiziert)' ? '—' : r.category;
        const kz = r.kz ? `<span class="bh-kz">Kz ${esc(r.kz)}</span>` : '';
        const receipt = r.receipt
            ? base
                ? `<a class="bh-link" href="${esc(base)}/documents/${r.receipt.docId}" target="_blank" rel="noreferrer">${esc(r.receipt.invoiceNumber || r.receipt.title || '#' + r.receipt.docId)}</a>`
                : `<span title="${esc(r.receipt.title)}">${esc(r.receipt.invoiceNumber || '#' + r.receipt.docId)}</span>`
            : '<span class="bh-muted">—</span>';
        const transferTag = r.transfer
            ? `<span class="bh-tag tf">⇄ Umbuchung ${r.transfer.direction === 'out' ? '→' : '←'} ${esc(r.transfer.partner)}</span>`
            : '';
        const paypalTag = r.paypal
            ? `<span class="bh-tag pp" title="${esc(r.paypal.item)}">via PayPal · ${esc(r.paypal.merchant || 'PayPal')}</span>`
            : '';
        return `
        <div class="bh-tr bh-tr-click${r.transfer ? ' is-transfer' : ''}" role="row" data-id="${esc(r.id)}">
          <span data-l="Datum">${esc(deDate(r.bookingDate))}</span>
          <span data-l="Gegenseite" class="bh-cp"><strong>${esc(r.counterparty || '—')}</strong><small>${esc((r.purpose || '').slice(0, 80))}</small><span class="bh-rowtags"><span class="bh-acct">${esc(r.account)}</span>${transferTag}${paypalTag}${extraTag}</span></span>
          <span data-l="Betrag" class="bh-r bh-amt ${amtCls}">${eur(r.amount)}</span>
          <span data-l="Kategorie" class="bh-cat">${esc(cat)} ${kz}</span>
          <span data-l="Quelle"><span class="bh-badge s-${esc(r.source)}">${esc(SOURCE_LABEL[r.source] ?? r.source)}</span></span>
          <span data-l="Beleg">${receipt}</span>
        </div>`;
    }
}

customElements.define('bh-transactions-view', BhTransactionsView);
