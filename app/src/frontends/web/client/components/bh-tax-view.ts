// <bh-tax-view> — read-only result cards for the four tax forms: Anlage EÜR,
// USt-Jahreserklärung, GewSt 1 A, Feststellung. Each fetched from its endpoint and
// rendered into an adw-card. Mirrors the CLI/MCP reports.

import { api } from '../lib/api.ts';
import { eur, pct, esc, deDate } from '../lib/format.ts';
import type { SteuerDashboard } from '../../../../core/elster/fristen.ts';

/** Definition-list line, with an optional glossary "?" help term on the label. */
const line = (label: string, value: string, cls = '', term = ''): string =>
    `<div class="bh-line ${cls}"><dt>${esc(label)}${term ? ` <bh-help term="${esc(term)}"></bh-help>` : ''}</dt><dd>${value}</dd></div>`;

/** Whole days from today until an ISO date (negative = overdue). */
function daysUntil(iso: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${iso}T00:00:00`);
    return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}
function fristText(iso: string): string {
    const n = daysUntil(iso);
    if (n > 0) return `in ${n} Tag${n === 1 ? '' : 'en'}`;
    if (n === 0) return 'heute fällig';
    return `überfällig seit ${-n} Tag${n === -1 ? '' : 'en'}`;
}

export class BhTaxView extends HTMLElement {
    private entity = '';
    private year = 2025;

    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.entity = entity;
        this.year = year;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Steuer-Übersicht ${year}…</div>`;
        const [euerR, usteR, gewstR, festR, dashR] = await Promise.all([
            api.euer(entity, year).catch((e) => ({ error: String(e) }) as const),
            api.uste(entity, year).catch((e) => ({ error: String(e) }) as const),
            api.gewst(entity, year).catch((e) => ({ error: String(e) }) as const),
            api.feststellung(entity, year).catch((e) => ({ error: String(e) }) as const),
            api.dashboard(entity, year).catch(() => null),
        ]);

        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Read-only · entspricht CLI/MCP &amp; den ERiC-validierten XML</div>
      </header>
      ${dashR ? this.dashboardBand(dashR) : ''}
      <div class="bh-cards">
        ${this.euerCard(euerR)}
        ${this.usteCard(usteR)}
        ${this.gewstCard(gewstR)}
        ${this.festCard(festR)}
      </div>`;
    }

    /** Top band: next deadline + estimated own tax load + the per-declaration Fristen. */
    private dashboardBand(d: SteuerDashboard): string {
        const next = d.fristen.length ? d.fristen.reduce((a, b) => (a.dueDate <= b.dueDate ? a : b)).dueDate : null;
        const total = d.load.total;
        const stats = `
      <div class="bh-stats bh-dash-stats">
        ${next ? `<div class="bh-stat"><span class="bh-stat-n">${esc(deDate(next))}</span><span class="bh-stat-l">Nächste Frist · ${esc(fristText(next))} <bh-help term="abgabefrist"></bh-help></span></div>` : ''}
        <div class="bh-stat"><span class="bh-stat-n ${total < 0 ? 'pos' : ''}">${eur(Math.abs(total))}</span><span class="bh-stat-l">${total >= 0 ? 'vsl. Nachzahlung' : 'vsl. Erstattung'} (USt + GewSt)</span></div>
        <div class="bh-stat"><span class="bh-stat-n">${eur(d.load.ust)}</span><span class="bh-stat-l">USt-Abschluss <bh-help term="abschlusszahlung"></bh-help></span></div>
        <div class="bh-stat"><span class="bh-stat-n">${eur(d.load.gewst)}</span><span class="bh-stat-l">Gewerbesteuer <bh-help term="gewerbesteuer"></bh-help></span></div>
      </div>`;
        const badge = (s: SteuerDashboard['fristen'][number]['status']) =>
            s === 'berechnet'
                ? '<span class="bh-frist-badge ok">✓ berechnet</span>'
                : s === 'hinweis'
                  ? '<span class="bh-frist-badge warn">ⓘ Hinweis</span>'
                  : '<span class="bh-frist-badge">offen</span>';
        const fristen = d.fristen
            .map(
                (f) => `
        <div class="bh-frist">
          <div class="bh-frist-main"><strong>${esc(f.label)}</strong><small>fällig ${esc(deDate(f.dueDate))} · ${esc(fristText(f.dueDate))}${f.note ? ` · ${esc(f.note)}` : ''}</small></div>
          <div class="bh-frist-amt">${f.amount != null ? `${esc(f.amountLabel ?? '')} <strong>${eur(f.amount)}</strong>` : ''}</div>
          ${badge(f.status)}
        </div>`,
            )
            .join('');
        const partner = d.partner.length
            ? `<p class="bh-muted bh-dash-note">Festgestellte Einkünfte ${eur(d.einkuenfte ?? 0)} → persönliche ESt der Gesellschafter: ${d.partner.map((p) => `${esc(p.name)} ${eur(p.anteil)}`).join(' · ')}. Die ESt-Höhe hängt von den übrigen Einkünften ab und wird hier nicht geschätzt.</p>`
            : '';
        return `<adw-card class="bh-dash">
      <div class="bh-card-head"><h2>Fristen &amp; Steuerlast</h2><span class="bh-pill">Regelfrist ohne Berater</span></div>
      ${stats}
      <div class="bh-fristen">${fristen}</div>
      ${partner}
    </adw-card>`;
    }

    private card(title: string, badge: string, body: string, term = '', pdf = ''): string {
        const help = term ? `<bh-help term="${esc(term)}"></bh-help>` : '';
        const pdfBtn = pdf
            ? `<a class="adw-button flat bh-linkbtn bh-pdf-btn" href="${esc(pdf)}" target="_blank" rel="noopener" title="Prüf-Datenblatt als PDF">PDF ↧</a>`
            : '';
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>${esc(title)}${help}</h2><div class="bh-card-head-actions">${pdfBtn}<span class="bh-pill">${esc(badge)}</span></div></div>
      ${body}
    </adw-card>`;
    }
    private err(title: string, e: { error: string }): string {
        return this.card(title, '—', `<div class="bh-error">${esc(e.error)}</div>`);
    }

    private euerCard(r: Awaited<ReturnType<typeof api.euer>> | { error: string }): string {
        if ('error' in r) return this.err('Anlage EÜR', r);
        const t = r.aggregate.totals;
        const catRows = (list: typeof r.aggregate.income, sign: number) =>
            list
                .map(
                    (c) =>
                        `<div class="bh-line"><dt>${esc(c.bucket)} <small>${esc(c.category)}</small></dt><dd>${eur(sign * c.net)}</dd></div>`,
                )
                .join('') || '<div class="bh-muted bh-line"><dt>—</dt><dd></dd></div>';
        const kz = r.kennzahlen
            .map(
                (k) =>
                    `<div class="bh-line bh-kzrow"><dt><span class="bh-kz">Kz ${esc(k.kz)}</span> ${esc(k.label)}</dt><dd>${eur(k.amount)}</dd></div>`,
            )
            .join('');
        const gap = r.aggregate.coverage.unclassified.length
            ? `<div class="bh-banner warn">⚠ ${r.aggregate.coverage.unclassified.length} unklassifiziert</div>`
            : `<div class="bh-banner ok">✓ 0 unklassifiziert</div>`;
        return this.card(
            'Anlage EÜR',
            'Gewinn ' + eur(t.profit),
            `<dl class="bh-dl">
        ${line('Betriebseinnahmen (netto)', eur(t.incomeNet), 'sum')}
        ${line('Betriebsausgaben (netto)', eur(t.expenseNet), 'sum')}
        ${line('Gewinn', eur(t.profit), 'total')}
        ${line('USt-Zahllast', eur(t.vatPayable))}
       </dl>
       ${gap}
       <details class="bh-details"><summary>Aufschlüsselung &amp; Kennzahlen</summary>
         <dl class="bh-dl">
           <div class="bh-subhead">Betriebseinnahmen</div>${catRows(r.aggregate.income, 1)}
           ${line('Summe Einnahmen (netto)', eur(t.incomeNet), 'sum')}
           <div class="bh-subhead">Betriebsausgaben</div>${catRows(r.aggregate.expenses, 1)}
           ${line('Summe Ausgaben (netto)', eur(t.expenseNet), 'sum')}
           <div class="bh-subhead">Kennzahlen-Blatt (Mein ELSTER)</div>${kz}
         </dl>
       </details>`,
            'euer',
            api.reportPdfUrl('euer', this.entity, this.year),
        );
    }

    private usteCard(r: Awaited<ReturnType<typeof api.uste>> | { error: string }): string {
        if ('error' in r) return this.err('USt-Jahreserklärung', r);
        const close = r.closingBalance >= 0 ? 'Abschlusszahlung' : 'Erstattung';
        return this.card(
            'USt-Jahreserklärung',
            'Zahllast ' + eur(r.vatPayable),
            `<dl class="bh-dl">
        ${line('USt-Zahllast', eur(r.vatPayable), 'sum')}
        ${line('− Vorauszahlungen', eur(r.prepaidVat))}
        ${line(close, eur(Math.abs(r.closingBalance)), 'total')}
       </dl>
       <details class="bh-details"><summary>Umsätze &amp; Vorsteuer</summary>
         <dl class="bh-dl">
           ${line('Umsätze 19 % (Kz 81)', eur(r.net_19))}
           ${line('Umsätze 7 % (Kz 86)', eur(r.net_7))}
           ${r.net_0 ? line('Steuerfrei / §13b', eur(r.net_0)) : ''}
           ${line('Vereinnahmte USt', eur(r.vat_out), '', 'vereinnahmte-ust')}
           ${line('Vorsteuer (Kz 66)', eur(r.vat_in), '', 'vorsteuer')}
         </dl>
       </details>`,
            'ust-zahllast',
            api.reportPdfUrl('uste', this.entity, this.year),
        );
    }

    private gewstCard(r: Awaited<ReturnType<typeof api.gewst>> | { error: string }): string {
        if ('error' in r) return this.err('Gewerbesteuer (GewSt 1 A)', r);
        const g = r.result;
        const gewinn = g.gewerbeertrag - g.sumHinzurechnungen + g.sumKuerzungen;
        return this.card(
            'Gewerbesteuer (GewSt 1 A)',
            'Messbetrag ' + eur(g.messbetrag),
            `<dl class="bh-dl">
        ${line('Gewerbeertrag (abgerundet)', eur(g.gewerbeertragRounded))}
        ${line('Steuermessbetrag', eur(g.messbetrag), 'total')}
       </dl>
       ${g.messbetrag === 0 ? '<div class="bh-banner ok">✓ Messbetrag 0 € (unter dem Freibetrag) — Erklärung wird dennoch abgegeben.</div>' : ''}
       <details class="bh-details"><summary>Berechnung</summary>
         <dl class="bh-dl">
           ${line('Gewinn aus Gewerbebetrieb', eur(gewinn))}
           ${g.sumHinzurechnungen ? line('+ Hinzurechnungen (§8)', eur(g.sumHinzurechnungen)) : ''}
           ${g.sumKuerzungen ? line('− Kürzungen (§9)', eur(g.sumKuerzungen)) : ''}
           ${line('Gewerbeertrag (abgerundet)', eur(g.gewerbeertragRounded))}
           ${line('− Freibetrag', eur(g.freibetrag))}
           ${line('Bemessungsgrundlage', eur(g.bemessungsgrundlage), 'sum')}
           ${line('× Steuermesszahl', pct(g.steuermesszahl))}
         </dl>
       </details>`,
            'gewst-messbetrag',
            api.reportPdfUrl('gewst', this.entity, this.year),
        );
    }

    private festCard(r: Awaited<ReturnType<typeof api.feststellung>> | { error: string }): string {
        if ('error' in r) return this.err('Feststellung (GbR)', r);
        const f = r.result;
        const sbvTotal = f.allocations.reduce((s, a) => s + a.sonderbetriebsausgaben, 0);
        const hasSbv = sbvTotal !== 0;
        const hasAufgabe = f.aufgabegewinn !== 0;
        const rows = f.allocations
            .map(
                (a) =>
                    `<div class="bh-line bh-alloc"><dt>${esc(a.gesellschafter.name)} <small>${pct(a.gesellschafter.quote)} · IdNr ${esc(a.gesellschafter.steuerId)}</small></dt><dd>${eur(a.gesamtAnteil)}</dd></div>`,
            )
            .join('');
        // Betriebsaufgabe: per-asset Entnahme (gemeiner Wert ./. Buchwert) — the figures
        // the co-partner should sanity-check, since the gemeine Werte are an estimate.
        const aufgabeDetail =
            hasAufgabe && r.aufgabe
                ? `<details class="bh-details"><summary>Betriebsaufgabe ${esc(r.aufgabe.datum)} — Entnahme Anlagevermögen</summary>
        <dl class="bh-dl">
          ${r.aufgabe.assets
              .map(
                  (a) =>
                      `<div class="bh-line"><dt>${esc(a.bezeichnung)} <small>gemeiner Wert ${eur(a.gemeinerWert)} − Buchwert ${eur(a.restbuchwert)}</small></dt><dd>${eur(a.gewinn)}</dd></div>`,
              )
              .join('')}
          ${line(f.aufgabegewinn < 0 ? 'Aufgabeverlust (§16/§34)' : 'Aufgabegewinn (§16/§34)', eur(f.aufgabegewinn), 'total')}
        </dl>
        <div class="bh-banner warn">Gemeine Werte sind eine Schätzung — bitte prüfen. Der Aufgabegewinn ist §16/§34-begünstigt und gewerbesteuerfrei.</div>
       </details>`
                : '';
        return this.card(
            'Feststellung (GbR)',
            'Einkünfte ' + eur(f.einkuenfteGesamt),
            `<dl class="bh-dl">
        ${line('Einkünfte aus Gewerbebetrieb', eur(f.einkuenfteGesamt), 'sum', 'einkuenfte')}
        <div class="bh-subhead">Verteilung auf die Gesellschafter</div>
        ${rows}
       </dl>
       <details class="bh-details"><summary>Herleitung</summary>
         <dl class="bh-dl">
           ${line('Laufender Gewinn (EÜR)', eur(f.totalProfit))}
           ${hasSbv ? line('− Sonderbetriebsausgaben', eur(sbvTotal), '', 'sonderbetriebsausgaben') : ''}
           ${hasSbv ? line('Festgestellte laufende Eink.', eur(f.festgestellteEinkuenfte)) : ''}
           ${hasAufgabe ? line(f.aufgabegewinn < 0 ? '+ Aufgabeverlust (§16)' : '+ Aufgabegewinn (§16)', eur(f.aufgabegewinn)) : ''}
         </dl>
       </details>
       ${aufgabeDetail}`,
            'feststellung',
            api.reportPdfUrl('feststellung', this.entity, this.year),
        );
    }
}

customElements.define('bh-tax-view', BhTaxView);
