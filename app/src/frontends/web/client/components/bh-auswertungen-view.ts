// <bh-auswertungen-view> — Auswertungen on ONE stacked screen (the v2 design), replacing the former
// BWA|Einblicke tab hub. Leads with the four headline totals, then the monthly BWA matrix
// (adw-data-grid; the operating-cost detail folds away), then the Einblicke card grid — contextual,
// data-derived advisory notices. Both the BWA and the Hinweise come off the same EÜR aggregate on
// the server; here we fetch /api/bwa + /api/hinweise in parallel. Read-only.

import type { AdwDataGrid, AdwDataGridColumn, AdwDataGridRow } from '@gjsify/adwaita-web';
import { api } from '../lib/api.ts';
import { eur, pct, esc } from '../lib/format.ts';
import { MONTHS } from '../lib/view-helpers.ts';

import { q } from '../lib/dom.ts';

type Bwa = Awaited<ReturnType<typeof api.bwa>>;
type Hinweise = Awaited<ReturnType<typeof api.hinweise>>;

/** „Geprüft, ohne Befund: …" / „Nicht prüfbar, weil …" — what a check says when it found nothing. */
function statusLine(h: Hinweise[number]): string {
    if (h.status === 'ohne_befund')
        return `<p class="bh-muted">Geprüft, ohne Befund${h.geprueft ? `: ${esc(h.geprueft)}` : ''}</p>`;
    if (h.status === 'nicht_pruefbar')
        return `<p class="bh-muted">Nicht prüfbar${h.weil ? `, weil ${esc(h.weil)}` : ''}</p>`;
    return '';
}

/** Hint key → glossary term for the inline "?" explanation. */
const HINT_TERM: Record<string, string> = {
    kleinunternehmer: 'kleinunternehmer',
    'beleg-luecke': 'vst-ohne-beleg',
    betriebsaufgabe: 'aufgabe',
    doppelzahlungen: 'doppelzahlung',
    afa: 'afa',
    frist: 'abgabefrist',
    'gewst-null': 'gewst-messbetrag',
    'ust-vorauszahlungen': 'abschlusszahlung',
};

export class BhAuswertungenView extends HTMLElement {
    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Auswertungen ${year}…</div>`;
        let bwa: Bwa;
        let hinweise: Hinweise;
        try {
            [bwa, hinweise] = await Promise.all([api.bwa(entity, year), api.hinweise(entity, year)]);
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
            return;
        }
        this.render(year, bwa, hinweise);
    }

    /** Position column + one per reported month + the year total (numeric = right-aligned figures). */
    private columns(year: number, r: Bwa): AdwDataGridColumn[] {
        return [
            { key: 'label', flex: 2 },
            ...r.months.map((m) => ({ key: `m${m}`, label: MONTHS[m] ?? String(m), numeric: true })),
            { key: 'total', label: `Σ ${year}`, numeric: true },
        ];
    }

    /** BWA lines → data-grid rows. Cost detail lines drop out when `collapsed`. */
    private rows(r: Bwa, collapsed: boolean): AdwDataGridRow[] {
        const fmt = (v: number | null, isMargin: boolean) => (v == null ? '—' : isMargin ? pct(v) : eur(v));
        return r.lines
            .filter((l) => !(collapsed && l.role === 'cost' && l.level === 'line'))
            .map((l) => {
                const isMargin = l.level === 'margin';
                const variant: AdwDataGridRow['variant'] =
                    l.level === 'result' ? 'total' : l.level === 'subtotal' ? 'subtotal' : 'normal';
                const row: AdwDataGridRow = { variant, label: l.label };
                r.months.forEach((m, i) => {
                    row[`m${m}`] = fmt(l.perMonth[i] ?? null, isMargin);
                });
                row.total = fmt(l.total, isMargin);
                return row;
            });
    }

    private render(year: number, r: Bwa, hinweise: Hinweise) {
        const hasBwa = r.months.length > 0;
        // The individual operating-cost lines fold under a toggle so the BWA opens focused on the
        // flow (Gesamtleistung → Betriebskosten → Betriebsergebnis).
        const costCount = r.lines.filter((l) => l.role === 'cost' && l.level === 'line').length;

        const kpiRow = hasBwa
            ? `<div class="bh-kpi-grid">
        <div class="bh-kpi"><div class="bh-kpi-l">Gesamtleistung</div><div class="bh-kpi-n">${eur(r.totals.gesamtleistung)}</div><div class="bh-kpi-s">BWA ${year}</div></div>
        <div class="bh-kpi"><div class="bh-kpi-l">Rohertrag</div><div class="bh-kpi-n">${eur(r.totals.rohertrag)}</div></div>
        <div class="bh-kpi"><div class="bh-kpi-l">Summe Betriebskosten</div><div class="bh-kpi-n">${eur(r.totals.betriebskosten)}</div></div>
        <div class="bh-kpi"><div class="bh-kpi-l">Betriebsergebnis</div><div class="bh-kpi-n ${r.totals.betriebsergebnis >= 0 ? 'pos' : 'neg'}">${eur(r.totals.betriebsergebnis)}</div></div>
      </div>`
            : '';

        const bwaSection = hasBwa
            ? `
      <h2 class="bh-section-title">BWA · monatlich</h2>
      ${
          costCount
              ? `<button type="button" class="bh-bwa-toggle" data-bwa-toggle aria-expanded="false"><span class="bh-bwa-chev">⌄</span> Betriebskosten-Zeilen <span class="bh-muted">(${costCount})</span></button>`
              : ''
      }
      <adw-data-grid data-el="bwa-grid" class="bh-bwa-grid"></adw-data-grid>
      <p class="bh-muted bh-bwa-note">Monatliche BWA aus den klassifizierten Buchungen (Buchungsmonat). Neutrale Posten (Privatentnahmen, interne Übertragungen, USt-Zahllast, Gewerbesteuer) zählen nicht ins Betriebsergebnis; AfA wird am 31.12. gezeigt. Das Jahres-Betriebsergebnis entspricht dem EÜR-Gewinn.</p>`
            : `<adw-card class="bh-muted">Keine Buchungen für ${year}.</adw-card>`;

        const hinweiseCards = hinweise
            .map(
                (h) => `
        <div class="bh-hinweis-card l-${esc(h.level)}">
          <span class="bh-hinweis-dot" aria-hidden="true"></span>
          <div class="bh-hinweis-body">
            <div class="bh-hinweis-head"><strong>${esc(h.title)}</strong>${HINT_TERM[h.key] ? `<bh-help term="${HINT_TERM[h.key]}"></bh-help>` : ''}${h.ref ? `<span class="bh-hinweis-ref">${esc(h.ref)}</span>` : ''}</div>
            <p>${esc(h.text)}</p>${statusLine(h)}${
                h.betroffen?.length
                    ? `<ul class="bh-muted">${h.betroffen.map((b) => `<li>${esc(b.zeile)}</li>`).join('')}${h.betroffenWeitere ? `<li>und ${h.betroffenWeitere} weitere</li>` : ''}</ul>`
                    : ''
            }
          </div>
        </div>`,
            )
            .join('');
        const einblickeSection = `
      <h2 class="bh-section-title">Einblicke <small>Hinweise aus deinen eigenen Zahlen — keine Steuerberatung</small></h2>
      ${hinweise.length ? `<div class="bh-hinweise-grid">${hinweiseCards}</div>` : `<adw-card class="bh-muted">Keine Hinweise für ${year}.</adw-card>`}`;

        this.innerHTML = `
      ${kpiRow}
      ${bwaSection}
      ${einblickeSection}`;

        if (!hasBwa) return;
        const grid = q<AdwDataGrid>(this, '[data-el="bwa-grid"]');
        if (!grid) return;
        grid.columns = this.columns(year, r);
        let collapsed = costCount > 0;
        grid.rows = this.rows(r, collapsed);

        const toggle = this.querySelector('[data-bwa-toggle]');
        toggle?.addEventListener('click', () => {
            collapsed = !collapsed;
            grid.rows = this.rows(r, collapsed);
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.querySelector('.bh-bwa-chev')?.classList.toggle('open', !collapsed);
        });
    }
}

customElements.define('bh-auswertungen-view', BhAuswertungenView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-auswertungen-view': BhAuswertungenView;
    }
}
