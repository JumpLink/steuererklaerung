// <bh-steuererklaerung-view> — the Steuererklärungs-Assistent as a v2 pill-stepper. Renders the
// shared TaxReturnPlan (api.wizard) — the SAME model the native app view shows — now at parity depth:
// the privat-ESt Steuer-Themen cards + Abzugs-Wasserfall (from plan.est), and, for a business entity,
// the machine Querprüfungen (api.crosschecks) folded into the honest readiness banner + Prüfung step.

import { api } from '../lib/api.ts';
import { esc, eur } from '../lib/format.ts';
import type { TaxReturnPlan } from '../../../../core/actions/elster/wizard.ts';
import type { EstThemeCard, EstWaterfallRow } from '../../../../core/actions/elster/est.ts';
import type { CrossCheckResult, CrossCheckSummary } from '../../../../core/actions/elster/cross-checks.ts';

type Step = TaxReturnPlan['steps'][number];
const STEP_ICON = { ok: '✓', warn: '⚠', blocked: '✗', info: 'ⓘ' } as const;
const THEME_GLYPH: Record<EstThemeCard['status'], string> = { done: '✓', open: '⚠', na: '○' };
const CHECK_GLYPH: Record<CrossCheckResult['status'], string> = { ok: '✓', warn: '⚠', error: '✗', info: 'ℹ' };

export class BhSteuererklaerungView extends HTMLElement {
    private entity = '';
    private year = 2025;
    private plan?: TaxReturnPlan;
    private active = 0;
    /** Machine cross-checks (business entities only; the privat ESt plan has none). */
    private checks: CrossCheckResult[] = [];
    private summary?: CrossCheckSummary;

    async connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Prüfe Steuererklärung ${this.year}…</div>`;
        try {
            this.plan = await api.wizard(this.entity, this.year);
        } catch (e) {
            this.innerHTML = `<div class="bh-error">${esc(String(e))}</div>`;
            return;
        }
        // Report reconciliation applies to a business entity; a privat/ESt plan (plan.est) has none.
        if (!this.plan.est) {
            try {
                const cc = await api.crosschecks(this.entity, this.year);
                this.checks = cc.checks;
                this.summary = cc.summary;
            } catch {
                /* best-effort — the view still renders without the Gegenprüfung */
            }
        }
        // Land on the first step that still needs attention, or on Prüfung when a cross-check errored.
        const firstOpen = this.plan.steps.findIndex((s) => s.status !== 'ok');
        const pruefung = this.plan.steps.findIndex((s) => s.id === 'pruefung');
        this.active = this.summary?.error && pruefung >= 0 ? pruefung : firstOpen >= 0 ? firstOpen : 0;
        this.render();
    }

    /** Honest readiness: the plan's own gate AND a clean machine reconciliation. */
    private get isReady(): boolean {
        return !!this.plan?.ready && (this.summary ? this.summary.clean : true);
    }

    /**
     * The monetary result hero (design 01–03): big signed amount (amber = Nachzahlung / grün =
     * Erstattung) + a mini-table of the key figures. Renders plan.summary (shared-core raw numbers).
     */
    private heroBlock(s: TaxReturnPlan['summary']): string {
        if (!s) return '';
        const rows = s.secondary
            .map(
                (l) =>
                    `<div class="bh-hero-row"><span>${esc(l.label)}</span><span class="bh-num">${eur(l.amount)}</span></div>`,
            )
            .join('');
        return `
      <div class="bh-result-hero">
        <div class="bh-hero-primary">
          <div class="bh-hero-label">${esc(s.primary.label)}</div>
          <div class="bh-hero-amt ${s.primary.kind === 'payment' ? 'pay' : 'refund'}">${eur(s.primary.amount)}</div>
          <div class="bh-hero-ctx">${esc(s.context)}</div>
        </div>
        <div class="bh-hero-figures">${rows}</div>
      </div>`;
    }

    private render() {
        const plan = this.plan;
        if (!plan) return;
        const exportable = plan.forms.filter((f) => f.canExport).length;
        const bannerClass = this.isReady ? 'ready' : this.summary?.error ? 'error' : 'pending';
        const statusText = this.isReady ? '✓ Abgabebereit' : '⚠ Noch nicht abgabebereit';
        // These annual forms have no Mein-ELSTER XML-Import (only the USt-VA does) → the Prüf-PDF is
        // the Vorlage to type into the web forms by hand.
        const sub = plan.est
            ? 'Schätzung — Werte manuell in Mein ELSTER eintragen (kein ESt-XML-Export)'
            : `${exportable}/${plan.forms.length} Formulare · Prüf-PDF als Vorlage — Werte in Mein ELSTER eintragen`;
        const errLine = this.summary?.error
            ? `<div class="bh-cc-errline">✗ ${this.summary.error} Querprüfung(en) mit Fehler — vor Abgabe klären.</div>`
            : '';
        const est = plan.est ? this.themesBlock(plan.est.themes) + this.waterfallBlock(plan.est.waterfall) : '';
        this.innerHTML = `
      <div class="bh-wizard">
        ${this.heroBlock(plan.summary)}
        <div class="bh-result-banner ${bannerClass}">
          <div class="bh-result-label">Steuererklärung ${plan.year}</div>
          <div class="bh-result-status">${statusText}</div>
          <div class="bh-result-sub">${esc(sub)}</div>
          ${errLine}
        </div>
        ${est}
        <div class="bh-stepper" role="tablist">${plan.steps.map((s, i) => this.stepPill(s, i)).join('')}</div>
        <div class="bh-step-panel">${this.stepPanel(plan.steps[this.active], plan)}</div>
      </div>`;
        this.querySelectorAll<HTMLButtonElement>('.bh-step').forEach((b) =>
            b.addEventListener('click', () => {
                const i = Number(b.dataset.i);
                if (i === this.active) return;
                this.active = i;
                this.render();
            }),
        );
        // "Hier beheben" deep-links: bubble a bh-navigate up to bh-app, which switches the view.
        this.querySelectorAll<HTMLButtonElement>('.bh-nav-action').forEach((b) =>
            b.addEventListener('click', () => {
                const view = b.dataset.nav;
                if (view)
                    this.dispatchEvent(
                        new CustomEvent('bh-navigate', { detail: { view }, bubbles: true, composed: true }),
                    );
            }),
        );
    }

    /** One stepper pill; the Prüfung pill reflects the machine verdict, not the static step status. */
    private stepPill(s: Step, i: number): string {
        let status: string = s.status;
        let badge = s.status === 'ok' ? '✓' : String(i + 1);
        if (s.id === 'pruefung' && this.summary) {
            status = this.summary.error ? 'blocked' : this.summary.warn ? 'warn' : 'ok';
            badge = this.summary.error ? '✗' : this.summary.warn ? '⚠' : '✓';
        }
        return `<button class="bh-step s-${esc(status)}${i === this.active ? ' active' : ''}" role="tab" aria-selected="${i === this.active}" data-i="${i}"><span class="bh-step-badge">${badge}</span><span class="bh-step-title">${esc(s.title)}</span></button>`;
    }

    // ── ESt-Themen cards + Abzugs-Wasserfall (privat) ──────────────────────────────────────
    private themesBlock(themes: EstThemeCard[]): string {
        if (!themes.length) return '';
        return `<h2 class="bh-section-title">Steuer-Themen</h2><div class="bh-themes">${themes.map((t) => this.themeCard(t)).join('')}</div>`;
    }

    private themeCard(t: EstThemeCard): string {
        const impact =
            t.impact !== 0
                ? `<span class="bh-pill ${t.impact >= 0 ? 'pos' : 'neg'}">${t.impact >= 0 ? '+' : '−'}${eur(Math.abs(t.impact))}</span>`
                : '';
        const items = t.items
            .map((it) => `<div class="bh-line"><dt>${esc(it.label)}</dt><dd>${esc(it.value)}</dd></div>`)
            .join('');
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>${THEME_GLYPH[t.status]} ${esc(t.title)}</h2><div class="bh-card-head-actions"><span class="bh-pill">${eur(t.amount)}</span>${impact}</div></div>
      <div class="bh-muted bh-theme-hint">${esc(t.hint)}</div>
      ${items ? `<dl class="bh-dl">${items}</dl>` : ''}
    </adw-card>`;
    }

    private waterfallBlock(rows: EstWaterfallRow[]): string {
        if (!rows.length) return '';
        const lines = rows
            .map((r) => {
                const cls = r.emphasis === 'result' ? ' total' : r.emphasis === 'total' ? ' sum' : '';
                const ddCls =
                    r.emphasis === 'result' ? (r.value.trim().startsWith('+') ? ' class="pos"' : ' class="neg"') : '';
                return `<div class="bh-line${cls}"><dt>${esc(r.label)}</dt><dd${ddCls}>${esc(r.value)}</dd></div>`;
            })
            .join('');
        return `<h2 class="bh-section-title">Berechnung</h2><dl class="bh-dl bh-waterfall">${lines}</dl>`;
    }

    // ── Step panel ─────────────────────────────────────────────────────────────────────────
    private stepPanel(step: Step, plan: TaxReturnPlan): string {
        // The Prüfung step leads with the machine Querprüfungen (business); the wizard's human-judgment
        // reminders drop below. A privat/ESt entity (no checks) falls through to the plain details.
        if (step.id === 'pruefung' && this.checks.length) {
            const rows = this.checks.map((c) => this.crossCheckRow(c)).join('');
            const manual = step.details.length
                ? `<h3 class="bh-cc-manual-h">Zusätzlich manuell prüfen</h3><div class="bh-step-rows">${step.details.map((d) => `<div class="bh-step-line">${esc(d)}</div>`).join('')}</div>`
                : '';
            return `
      <div class="bh-step-head">
        <h2 class="bh-step-h">${STEP_ICON[step.status]} ${esc(step.title)}</h2>
        <div class="bh-muted">${esc(this.verdictText())}</div>
      </div>
      <div class="bh-cc-list">${rows}</div>
      ${manual}`;
        }
        const body =
            step.id === 'formulare'
                ? `<div class="bh-step-rows">${plan.forms.map((f) => this.formRow(f)).join('')}</div>`
                : step.details.length
                  ? `<div class="bh-step-rows">${step.details.map((d) => `<div class="bh-step-line">${esc(d)}</div>`).join('')}</div>`
                  : `<div class="bh-muted">Keine offenen Punkte in diesem Schritt.</div>`;
        return `
      <div class="bh-step-head">
        <h2 class="bh-step-h">${STEP_ICON[step.status]} ${esc(step.title)}</h2>
        <div class="bh-muted">${esc(step.headline)}</div>
      </div>
      ${body}
      ${this.stepActions(step)}`;
    }

    /** "Hier beheben" deep-links: buttons that dispatch bh-navigate so bh-app switches the view. */
    private stepActions(step: Step): string {
        if (!step.actions?.length) return '';
        const btns = step.actions
            .map(
                (a) =>
                    `<button class="adw-button suggested-action bh-nav-action" data-nav="${esc(a.view)}">${esc(a.label)} →</button>`,
            )
            .join('');
        return `<div class="bh-step-actions">${btns}</div>`;
    }

    private verdictText(): string {
        const s = this.summary;
        if (!s) return '';
        const counts = `${s.ok} ok · ${s.warn} Warnung(en) · ${s.error} Fehler`;
        if (s.error > 0) return `${counts} — nicht abgabebereit, bis die Fehler geklärt sind.`;
        if (s.warn > 0) return `${counts} — Warnungen vor der Abgabe prüfen.`;
        return `${counts} — keine Abweichungen gefunden.`;
    }

    private crossCheckRow(r: CrossCheckResult): string {
        const nums: string[] = [];
        if (r.expected != null) nums.push(`erwartet ${eur(r.expected)}`);
        if (r.actual != null) nums.push(`ist ${eur(r.actual)}`);
        if (r.delta != null) nums.push(`Δ ${eur(r.delta)}`);
        const numLine = nums.length ? `<div class="bh-cc-nums">${nums.join(' · ')}</div>` : '';
        return `<div class="bh-cc-row"><span class="bh-cc-glyph ${esc(r.status)}">${CHECK_GLYPH[r.status]}</span><div class="bh-cc-body"><strong>${esc(r.label)}</strong><div class="bh-muted">${esc(r.detail)}</div>${numLine}</div></div>`;
    }

    private formRow(f: TaxReturnPlan['forms'][number]): string {
        const figures = f.figures.map((fig) => `${esc(fig.label)}: ${esc(fig.value)}`).join(' · ');
        // `est` has no Prüf-PDF yet (canExport is always false) — the guard also narrows f.form to
        // the four business forms reportPdfUrl accepts.
        const pdf =
            f.canExport && f.form !== 'est'
                ? `<a class="adw-button flat bh-linkbtn bh-pdf-btn" href="${esc(api.reportPdfUrl(f.form, this.entity, this.year))}" target="_blank" rel="noopener" title="Prüf-Datenblatt als PDF">PDF ↧</a>`
                : `<span class="bh-muted">${esc(f.blockedReason ?? '')}</span>`;
        return `<div class="bh-step-line bh-alloc"><div><strong>${esc(f.title)}</strong> <small class="bh-muted">${figures}</small></div><div>${pdf}</div></div>`;
    }
}

customElements.define('bh-steuererklaerung-view', BhSteuererklaerungView);
