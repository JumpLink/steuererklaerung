// <bh-ustva-view> — read-only USt-VA (Umsatzsteuer-Voranmeldung) review, one adw-card per quarter
// with data: the headline Kennzahlen (Kz 81 · USt · Kz 66 · Kz 83 Zahllast) and, behind a
// <details>, the included in-/outgoing documents. Mirrors the CLI/MCP `elster ustva` report and the
// native app's USt-VA view (Ist-Versteuerung, BMF-Umrechnung).

import { api } from '../lib/api.ts';
import { eur, esc } from '../lib/format.ts';
import type { UstvaYearQuarter, UstvaDocumentDetail } from '../../../../core/elster/ustva-aggregate.ts';

/** Definition-list line. */
const line = (label: string, value: string, cls = ''): string =>
    `<div class="bh-line ${cls}"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

export class BhUstvaView extends HTMLElement {
    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade USt-VA ${year}…</div>`;

        let quarters: UstvaYearQuarter[];
        try {
            quarters = await api.ustva(entity, year);
        } catch (e) {
            this.innerHTML = `<div class="bh-error">${esc(String(e))}</div>`;
            return;
        }

        const withData = quarters.filter((q) => q.outgoing.length > 0 || q.incoming.length > 0);
        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Read-only · Ist-Versteuerung · entspricht der ERiC-validierten XML</div>
      </header>
      ${
          withData.length
              ? `<div class="bh-cards">${withData.map((q) => this.card(q, year, entity)).join('')}</div>`
              : `<adw-card class="bh-taxcard"><div class="bh-muted">Keine USt-relevanten Belege in ${year}.</div></adw-card>`
      }`;
    }

    private docs(list: UstvaDocumentDetail[], dir: string): string {
        return (
            list
                .map((d) => {
                    const meta = [
                        dir,
                        d.date_used ?? '—',
                        d.total_net != null ? `netto ${eur(d.total_net)}` : '',
                        d.invoice_currency && d.invoice_currency.toUpperCase() !== 'EUR' ? d.invoice_currency : '',
                    ]
                        .filter(Boolean)
                        .join(' · ');
                    return `<div class="bh-line"><dt>${esc(d.title ?? `#${d.id}`)} <small>${esc(meta)}</small></dt><dd>${eur(d.tax_amount ?? 0)}</dd></div>`;
                })
                .join('') || '<div class="bh-muted bh-line"><dt>—</dt><dd></dd></div>'
        );
    }

    private card(q: UstvaYearQuarter, year: number, entity: string): string {
        const a = q.aggregate;
        const close = q.zahllast < 0 ? 'Erstattung' : 'Zahllast';
        const bmf = q.missingBmfRates.length
            ? `<div class="bh-banner warn">⚠ Fehlende BMF-Umrechnungskurse: ${esc(q.missingBmfRates.map((m) => `#${m.id} ${m.currency} ${m.month}`).join(', '))}</div>`
            : '';
        // The only ELSTER form Mein ELSTER accepts as an XML upload — a flat download of the plain
        // <Anmeldungssteuern> ISO-8859-15 file. Withheld when BMF rates are missing (figures would be
        // understated); the amber banner above then explains why.
        const xmlAction = q.missingBmfRates.length
            ? '<div class="bh-card-action bh-muted">XML-Export nach Ergänzung der BMF-Kurse verfügbar</div>'
            : `<div class="bh-card-action"><a class="adw-button flat bh-linkbtn" href="${esc(api.ustvaXmlUrl(entity, year, q.quarter))}" download title="Umsatzsteuer-Voranmeldung als XML für den Mein-ELSTER-Import herunterladen">Für Mein ELSTER (XML) ↧</a></div>`;
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>Q${q.quarter} ${year}</h2><span class="bh-pill">${esc(close)} ${eur(Math.abs(q.zahllast))}</span></div>
      <dl class="bh-dl">
        ${line('Steuerpfl. Umsätze 19 % (Kz 81)', eur(a.net_19))}
        ${a.net_7 ? line('Steuerpfl. Umsätze 7 % (Kz 86)', eur(a.net_7)) : ''}
        ${line('Umsatzsteuer', eur(a.vat_out))}
        ${line('Vorsteuer (Kz 66)', eur(a.vat_in))}
        ${line(`${close} (Kz 83)`, eur(q.zahllast), 'total')}
      </dl>
      ${xmlAction}
      ${bmf}
      <details class="bh-details"><summary>Belege (${q.outgoing.length} Ausgang · ${q.incoming.length} Eingang)</summary>
        <dl class="bh-dl">
          <div class="bh-subhead">Ausgangsrechnungen (Umsatz)</div>${this.docs(q.outgoing, 'Ausgang')}
          <div class="bh-subhead">Eingangsrechnungen (Vorsteuer)</div>${this.docs(q.incoming, 'Eingang')}
        </dl>
      </details>
    </adw-card>`;
    }
}

customElements.define('bh-ustva-view', BhUstvaView);
