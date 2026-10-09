// PDF export via print-to-PDF: assemble a compact, paginated review report from the
// (cached) API data, force light theme, open the browser print dialog → "Save as PDF".
// No server-side PDF engine (which is hard on GJS) — full control via @media print CSS.

import { api } from './api.ts';
import { eur, pct, deDate, esc } from './format.ts';
import { aufgabeCoverage } from './view-helpers.ts';
import { isVstNoBeleg } from './view-helpers.ts';
import type { EuerTxAggregate } from '../../../../core/elster/euer-transactions.ts';

const today = (): string => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
};

const catRows = (list: EuerTxAggregate['income']): string =>
    list
        .map((c) => `<tr><td>${esc(c.bucket)} <span class="bh-pr-sub">${esc(c.category)}</span></td><td class="bh-pr-num">${eur(c.net)}</td></tr>`)
        .join('') || '<tr><td>—</td><td></td></tr>';

export async function printReport(entity: string, year: number): Promise<void> {
    const [meta, euer, uste, gewst, fest, tx, sk] = await Promise.all([
        api.meta(),
        api.euer(entity, year),
        api.uste(entity, year).catch(() => null),
        api.gewst(entity, year).catch(() => null),
        api.feststellung(entity, year).catch(() => null),
        api.transactions(entity, year),
        api.steuerkonto(entity, year).catch(() => null),
    ]);
    const entityName = meta.entities.find((e) => e.id === entity)?.name ?? 'Steuererklärung';

    const rows = tx.rows;
    const t = tx.totals;
    const withReceipt = rows.filter((r) => r.receipt).length;
    const unclassified = rows.filter((r) => r.source === 'unclassified').length;
    const vstGap = rows.filter(isVstNoBeleg);
    const vstSum = vstGap.reduce((s, r) => s + Math.abs(r.vat), 0);

    // Betriebsaufgabe: laufender Teil bis activeTo, §24-nachträglich kept vs successor excluded.
    const { kept, excluded, keptInc, keptExp } = aufgabeCoverage(tx.coverage.outsidePeriod ?? []);
    const aufgabeNote =
        kept.length || excluded.length
            ? `<p class="bh-pr-note">Betriebsaufgabe: laufender Teil bis <strong>${esc(tx.coverage.activeTo)}</strong>. ${kept.length} nachträgliche §24-Buchung(en) im Ergebnis (gewerbesteuerfrei): Einnahmen ${eur(keptInc)} − Ausgaben ${eur(keptExp)} = ${eur(keptInc - keptExp)}${excluded.length ? ` · ${excluded.length} Buchung(en) als Nachfolger/JumpLink ausgeschlossen` : ''}.</p>`
            : '';

    // Geleistete Steuerzahlungen (steuerkonto) — actual flows per entity, not the declarations.
    const skTable = sk
        ? `<h2 class="bh-pr-break">2 · Geleistete Steuerzahlungen <span class="bh-pr-sub">Abgleich Mein ELSTER · kein amtlicher FA-Stand</span></h2>
      <table class="bh-pr-tbl">
        <thead><tr><th>Entität</th><th>Art</th><th class="bh-pr-num">gezahlt</th><th class="bh-pr-num">erstattet</th><th class="bh-pr-num">Saldo</th></tr></thead>
        <tbody>${
            sk.groups
                .map(
                    (g) =>
                        `<tr><td>${esc(g.entity)}</td><td>${esc(g.art)}</td><td class="bh-pr-num">${eur(g.gezahlt)}</td><td class="bh-pr-num">${eur(g.erstattet)}</td><td class="bh-pr-num ${g.netto >= 0 ? 'pos' : 'neg'}">${g.netto >= 0 ? `Erstattung ${eur(g.netto)}` : `gezahlt ${eur(-g.netto)}`}</td></tr>`,
                )
                .join('') || '<tr><td>— keine —</td><td></td><td></td><td></td><td></td></tr>'
        }</tbody>
      </table>
      ${sk.internalReserve.count ? `<p class="bh-pr-note">${sk.internalReserve.count} interne Umbuchungen zwischen eigenen Konten (${eur(sk.internalReserve.out)}, netto 0) — keine Behördenzahlung, ignoriert.</p>` : ''}`
        : '';

    const festRows = fest
        ? fest.result.allocations
              .map(
                  (a) =>
                      `<tr><td>${esc(a.gesellschafter.name)} <span class="bh-pr-sub">${pct(a.gesellschafter.quote)} · IdNr ${esc(a.gesellschafter.steuerId)}</span></td><td class="bh-pr-num">${eur(a.gesamtAnteil)}</td></tr>`,
              )
              .join('')
        : '';

    const txRows = rows
        .map((r) => {
            const extra = [
                esc(r.account),
                r.transfer ? `⇄ ${esc(r.transfer.partner)}` : '',
                r.paypal ? `PayPal: ${esc(r.paypal.merchant || 'PayPal')}` : '',
            ]
                .filter(Boolean)
                .join(' · ');
            return `<tr class="${r.transfer ? 'bh-pr-muted' : ''}">
        <td>${esc(deDate(r.bookingDate))}</td>
        <td>${esc((r.counterparty || '—').slice(0, 40))}${extra ? ` <span class="bh-pr-sub">${extra}</span>` : ''}</td>
        <td class="bh-pr-num ${r.amount < 0 ? 'neg' : 'pos'}">${eur(r.amount)}</td>
        <td>${esc(r.category === '(unklassifiziert)' ? '—' : r.category)}${r.kz ? ` <span class="bh-pr-sub">Kz ${esc(r.kz)}</span>` : ''}</td>
        <td>${r.source === 'document' ? 'Beleg' : r.source === 'rule' ? 'Regel' : '—'}</td>
        <td>${r.receipt ? esc(r.receipt.invoiceNumber || '#' + r.receipt.docId) : '—'}</td>
      </tr>`;
        })
        .join('');

    const html = `
    <div class="bh-pr-head">
      <h1>${esc(entityName)}</h1>
      <div class="bh-pr-title">Steuerlicher Prüfbericht · Wirtschaftsjahr ${year}</div>
      <div class="bh-pr-meta">Stand ${today()} · read-only, zur Überprüfung durch die Gesellschafter · entspricht den ERiC-validierten ELSTER-Daten</div>
    </div>

    <h2>1 · Ergebnis &amp; Steuern</h2>
    <div class="bh-pr-grid2">
      <table class="bh-pr-tbl"><caption>Anlage EÜR</caption>
        <tr><td>Summe Betriebseinnahmen (netto)</td><td class="bh-pr-num">${eur(t.incomeNet)}</td></tr>
        <tr><td>Summe Betriebsausgaben (netto)</td><td class="bh-pr-num">${eur(t.expenseNet)}</td></tr>
        <tr class="bh-pr-total"><td>Gewinn</td><td class="bh-pr-num">${eur(t.profit)}</td></tr>
      </table>
      <table class="bh-pr-tbl"><caption>USt-Jahreserklärung</caption>
        ${uste ? `<tr><td>Umsätze 19 % (Kz 81)</td><td class="bh-pr-num">${eur(uste.net_19)}</td></tr>
        <tr><td>Vereinnahmte USt</td><td class="bh-pr-num">${eur(uste.vat_out)}</td></tr>
        <tr><td>Vorsteuer (Kz 66)</td><td class="bh-pr-num">${eur(uste.vat_in)}</td></tr>
        <tr class="bh-pr-total"><td>USt-Zahllast</td><td class="bh-pr-num">${eur(uste.vatPayable)}</td></tr>` : '<tr><td>— ohne ELSTER-Config —</td><td></td></tr>'}
      </table>
      <table class="bh-pr-tbl"><caption>Gewerbesteuer (GewSt 1 A)</caption>
        ${gewst ? `<tr><td>Gewerbeertrag (abgerundet)</td><td class="bh-pr-num">${eur(gewst.result.gewerbeertragRounded)}</td></tr>
        <tr><td>Freibetrag</td><td class="bh-pr-num">${eur(gewst.result.freibetrag)}</td></tr>
        <tr class="bh-pr-total"><td>Steuermessbetrag</td><td class="bh-pr-num">${eur(gewst.result.messbetrag)}</td></tr>` : '<tr><td>—</td><td></td></tr>'}
      </table>
      <table class="bh-pr-tbl"><caption>Gesonderte &amp; einheitliche Feststellung</caption>
        ${fest ? `<tr><td>Laufender Gewinn (EÜR)</td><td class="bh-pr-num">${eur(fest.result.totalProfit)}</td></tr>${fest.result.festgestellteEinkuenfte !== fest.result.totalProfit ? `<tr><td>− Sonderbetriebsausgaben</td><td class="bh-pr-num">${eur(fest.result.totalProfit - fest.result.festgestellteEinkuenfte)}</td></tr>` : ''}${fest.result.aufgabegewinn !== 0 ? `<tr><td>${fest.result.aufgabegewinn < 0 ? '+ Aufgabeverlust (§16/§34)' : '+ Aufgabegewinn (§16/§34)'}</td><td class="bh-pr-num">${eur(fest.result.aufgabegewinn)}</td></tr>` : ''}<tr class="bh-pr-total"><td>Einkünfte aus Gewerbebetrieb</td><td class="bh-pr-num">${eur(fest.result.einkuenfteGesamt)}</td></tr>${festRows}` : '<tr><td>—</td><td></td></tr>'}
      </table>
    </div>
    ${
        fest?.aufgabe && fest.result.aufgabegewinn !== 0
            ? `<table class="bh-pr-tbl"><caption>Betriebsaufgabe ${esc(fest.aufgabe.datum)} — Entnahme Anlagevermögen (gemeiner Wert ./. Buchwert)</caption>
        ${fest.aufgabe.assets
            .map(
                (a) =>
                    `<tr><td>${esc(a.bezeichnung)} <span class="bh-pr-sub">gemeiner Wert ${eur(a.gemeinerWert)} − Buchwert ${eur(a.restbuchwert)}</span></td><td class="bh-pr-num ${a.gewinn < 0 ? 'neg' : 'pos'}">${eur(a.gewinn)}</td></tr>`,
            )
            .join('')}
        <tr class="bh-pr-total"><td>${fest.result.aufgabegewinn < 0 ? 'Aufgabeverlust' : 'Aufgabegewinn'} (§16/§34, gewerbesteuerfrei)</td><td class="bh-pr-num">${eur(fest.result.aufgabegewinn)}</td></tr>
      </table>
      <p class="bh-pr-note">Gemeine Werte sind eine Schätzung — bitte prüfen.</p>`
            : ''
    }
    ${aufgabeNote}
    ${skTable}

    <h2>3 · Beleg-Übersicht</h2>
    <table class="bh-pr-tbl">
      <tr><td>Buchungen (EÜR-relevant)</td><td class="bh-pr-num">${rows.length}</td></tr>
      <tr><td>davon mit verknüpftem Beleg</td><td class="bh-pr-num">${withReceipt}</td></tr>
      <tr><td>unklassifiziert</td><td class="bh-pr-num">${unclassified}</td></tr>
      <tr class="${vstGap.length ? 'bh-pr-warn' : ''}"><td>Vorsteuer ohne verknüpften Beleg</td><td class="bh-pr-num">${eur(vstSum)} · ${vstGap.length} Buchungen</td></tr>
    </table>
    <p class="bh-pr-note">Belege werden nicht an ELSTER übermittelt (Belegvorhaltepflicht). Für den Vorsteuerabzug müssen die Rechnungen aufbewahrt und auf Anforderung des Finanzamts vorgelegt werden können.</p>

    <h2 class="bh-pr-break">4 · EÜR im Detail</h2>
    <div class="bh-pr-grid2">
      <table class="bh-pr-tbl"><caption>Betriebseinnahmen</caption>${catRows(euer.aggregate.income)}<tr class="bh-pr-total"><td>Summe</td><td class="bh-pr-num">${eur(t.incomeNet)}</td></tr></table>
      <table class="bh-pr-tbl"><caption>Betriebsausgaben</caption>${catRows(euer.aggregate.expenses)}<tr class="bh-pr-total"><td>Summe</td><td class="bh-pr-num">${eur(t.expenseNet)}</td></tr></table>
    </div>

    <h2 class="bh-pr-break">5 · Transaktionen (${rows.length})</h2>
    <table class="bh-pr-tbl bh-pr-txtbl">
      <thead><tr><th>Datum</th><th>Gegenseite</th><th class="bh-pr-num">Betrag</th><th>Kategorie</th><th>Quelle</th><th>Beleg</th></tr></thead>
      <tbody>${txRows}</tbody>
    </table>`;

    const wrap = document.createElement('div');
    wrap.id = 'bh-print';
    wrap.innerHTML = html;

    const root = document.documentElement;
    const wasDark = root.classList.contains('theme-dark');
    root.classList.remove('theme-dark');
    root.classList.add('theme-light');
    document.body.appendChild(wrap);

    const cleanup = () => {
        wrap.remove();
        root.classList.toggle('theme-dark', wasDark);
        root.classList.toggle('theme-light', !wasDark);
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    // Let layout settle, then open the print dialog (user picks "Save as PDF").
    await new Promise((r) => setTimeout(r, 80));
    window.print();
}
