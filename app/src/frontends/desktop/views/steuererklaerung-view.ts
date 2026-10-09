/**
 * <BhSteuererklaerungView> — the Steuererklärungs-Assistent: a step-by-step readiness view for the
 * annual return (Vollständigkeit → Anpassungen → Formulare → Prüfung → Zusammenfassung), ending with
 * the ERiC-checked Prüf-PDFs to type into the Mein-ELSTER web forms (these annual forms have no
 * XML-Import — only the USt-VA does; see ustva-view.ts for that export).
 *
 * Pure adapter over the shared {@link TaxReturnPlan} core (presenters/steuer.ts): each step is one
 * PreferencesGroup (status icon + headline + detail rows); the "Formulare" step lists the per-form
 * previews with a Save-As Prüf-PDF button (the same presenters/steuer.ts loaders + savePdfViaDialog the
 * Steuer view uses). Read-only + async (fetches Paperless once via the cached aggregate). Only
 * entities with an ELSTER config reach this view.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './steuererklaerung-view.blp';
import {
    loadTaxReturnPlan,
    loadCrossChecks,
    loadEuerPdf,
    loadUstePdf,
    loadGewstPdf,
    loadFeststellungPdf,
    loadEstPdf,
} from '../../../core/presenters/steuer.ts';
import { appSession } from '../data/session.ts';
import { navigateTo, type NavViewId } from '../nav.ts';
import { snapshotFormsFromPlan, ustvaTargetsForYear } from '../data/submission.ts';
import { SubmissionSection } from './absenden-section.ts';
import { BhToggleTabs } from '../widgets/toggle-tabs.ts';
import type {
    TaxReturnPlan,
    TaxReturnSummary,
    WizardFormPreview,
    WizardStep,
    StepStatus,
} from '../../../core/actions/elster/wizard.ts';
import {
    summarizeCrossChecks,
    type CrossCheckResult,
    type CrossCheckStatus,
    type CrossCheckSummary,
} from '../../../core/actions/elster/cross-checks.ts';
import type { EstThemeCard, EstWaterfallRow } from '../../../core/actions/elster/est.ts';
import type { AppEntity } from '../entities.ts';
import { fmtDe as fmt } from '../../../core/lib/money.ts';
import { LoadToken, loadIntoStack, markup, saveFileViaDialog, amountLabel } from './util.ts';
import { errorDialog } from './dialogs.ts';

/** Icon + accent per Steuer-Thema status (design 08-steuer.png). */
const THEME_STATUS: Record<EstThemeCard['status'], { icon: string; css: string[] }> = {
    done: { icon: 'emblem-ok-symbolic', css: ['success'] },
    open: { icon: 'dialog-warning-symbolic', css: ['warning'] },
    na: { icon: 'radio-symbolic', css: ['dim-label'] },
};

/** Symbolic icon per step status — shown on the stepper's ViewSwitcher tabs. */
const STEP_STATUS_ICON: Record<StepStatus, string> = {
    ok: 'emblem-ok-symbolic',
    warn: 'dialog-warning-symbolic',
    blocked: 'dialog-error-symbolic',
    info: 'dialog-information-symbolic',
};

/**
 * Glyph + accent + tab-icon per machine cross-check status (mirrors the CLI's glyph() + the
 * provenance-chip idiom): ok→success ✓, warn→warning ⚠, error→error ✗, info→dim ℹ.
 */
const CROSSCHECK_STATUS: Record<CrossCheckStatus, { glyph: string; css: string; icon: string }> = {
    ok: { glyph: '✓', css: 'success', icon: 'emblem-ok-symbolic' },
    warn: { glyph: '⚠', css: 'warning', icon: 'dialog-warning-symbolic' },
    error: { glyph: '✗', css: 'error', icon: 'dialog-error-symbolic' },
    info: { glyph: 'ℹ', css: 'dim-label', icon: 'dialog-information-symbolic' },
};

/** Per-form Prüf-PDF loaders (byte-producing) — the same ones the Steuer view exports. */
type PdfLoader = (entity: AppEntity, year: number) => Promise<{ filename: string; bytes: Uint8Array }>;
const PDF_LOADERS: Partial<Record<WizardFormPreview['form'], PdfLoader>> = {
    euer: (e, y) => loadEuerPdf(appSession(), e, y),
    uste: (e, y) => loadUstePdf(appSession(), e, y),
    gewst: (e, y) => loadGewstPdf(appSession(), e, y),
    feststellung: (e, y) => loadFeststellungPdf(appSession(), e, y),
    est: (e, y) => loadEstPdf(appSession(), e, y),
};

export class BhSteuererklaerungView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _steps_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhSteuererklaerungView',
                Template,
                InternalChildren: ['stack', 'error_page', 'steps_box'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();

    reload(entity: AppEntity, year: number): void {
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Steuererklärung konnte nicht geprüft werden',
            // Plan + machine cross-checks in one load: both derive from the SAME cached EÜR aggregate,
            // so the second call is a cache hit (no extra Paperless fetch) and fill() renders the
            // Gegenprüfung + honest readiness with full knowledge — no post-hoc widget shuffling.
            load: async () => {
                const session = appSession();
                const plan = await loadTaxReturnPlan(session, entity, year);
                const checks = await loadCrossChecks(session, entity, year);
                return { plan, checks };
            },
            fill: ({ plan, checks }) => this.fill(plan, checks, entity, year),
        });
    }

    private clearBox(): void {
        let child = this._steps_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._steps_box.remove(child);
            child = next;
        }
    }

    private fill(plan: TaxReturnPlan, checks: CrossCheckResult[], entity: AppEntity, year: number): void {
        this.clearBox();
        // Honest readiness: the plan is only abgabebereit when NO machine cross-check errored. The
        // verdict logic stays in core (summarizeCrossChecks); the view just ANDs the two flags.
        const summary = summarizeCrossChecks(checks);
        const ready = plan.ready && summary.clean;
        // Money-first hero (design 01–03): the big expected payment/refund + the key figures, above the
        // readiness banner. Absent on a blocked plan.
        if (plan.summary) this._steps_box.append(this.heroSummary(plan.summary));
        this._steps_box.append(this.resultBanner(plan, ready, summary));

        // Private ESt: the Finanzguru-style Steuer-Themen cards + Abzugs-Wasserfall are the primary
        // view (design 08-steuer.png); the stepper below adds the Abgabe-/Prüfungs-Schritte.
        if (plan.est) {
            this._steps_box.append(this.estThemesGroup(plan.est.themes));
            this._steps_box.append(this.estWaterfallGroup(plan.est.waterfall));
        }

        // Absenden — the ELSTER submission chain for the snapshot-able Formulare. Since the ESt has an
        // E10 XML builder + snapshot, a `privat`/ESt plan gets the Absenden chain too (est). Per the v3
        // design it lives INSIDE the "Abgabe" step. Self-loads + reloads after actions.
        const annual = snapshotFormsFromPlan(plan.forms.map((f) => f.form)).map((form) => ({ form }));
        // The USt-VA belongs here too, and only ever half-did: the app could export its XML and
        // never file it, so the one return that recurs four times a year was the one the app had no
        // Absenden chain for. Its rows come from the entity's OWN filing rhythm — a monthly filer
        // gets twelve, not four quarters they do not file.
        const periodic =
            entity.elster && entity.dmsType === 'paperless' ? ustvaTargetsForYear(year, entity.elster.period) : [];
        const targets = [...periodic, ...annual];
        let submission: SubmissionSection | null = null;
        if (targets.length > 0) {
            submission = new SubmissionSection();
            submission.load(entity, year, targets);
        }

        // Chip stepper (design): segmented ToggleButtons over a NON-homogeneous stack, so each step
        // page takes exactly its own height — Adw.ViewStack would stretch every page to the tallest
        // one and leave a big gap under short steps (the reported bug).
        const hasChecks = checks.length > 0;
        const tabs = new BhToggleTabs();
        plan.steps.forEach((step, i) => {
            // The Gegenprüfung tab reflects the machine verdict (error → red) rather than the plan's
            // static step status, so the honest gate is visible before the tab is even opened.
            const icon =
                step.id === 'pruefung' && hasChecks
                    ? CROSSCHECK_STATUS[summary.status].icon
                    : STEP_STATUS_ICON[step.status];
            tabs.add(
                `s${i}`,
                step.tab ?? step.title,
                this.stepContent(
                    step,
                    plan,
                    checks,
                    summary,
                    entity,
                    year,
                    step.id === 'zusammenfassung' ? submission : null,
                ),
                { iconName: icon },
            );
        });
        this._steps_box.append(tabs);

        // Land on the first step that still needs attention — a cross-check error makes Gegenprüfung one.
        const firstOpen = plan.steps.findIndex(
            (s) => s.status !== 'ok' || (s.id === 'pruefung' && hasChecks && !summary.clean),
        );
        if (firstOpen >= 0) tabs.select(`s${firstOpen}`);

        // STEUER_APP_STEP=<id> (dev/testing hook): open a specific step, e.g. `zusammenfassung` for
        // the Absenden chain. The chips are inside a widget, so the rig cannot reach them by type or
        // css class — and a step that only opens when its data is incomplete is not screenshottable.
        const wanted = process.env.STEUER_APP_STEP;
        if (wanted) {
            const index = plan.steps.findIndex((s) => s.id === wanted);
            if (index >= 0) tabs.select(`s${index}`);
            else
                console.error(
                    `[app] STEUER_APP_STEP="${wanted}" unbekannt. Schritte: ${plan.steps.map((s) => s.id).join(', ')}`,
                );
        }

        if (process.env.STEUER_APP_DEBUG) {
            console.error(
                `[app] Steuererklärung ${plan.entityId} ${plan.year}: ${ready ? 'abgabebereit' : 'nicht bereit'}, ` +
                    `${plan.forms.filter((f) => f.canExport).length}/${plan.forms.length} Formulare exportierbar, ` +
                    `Querprüfungen ${summary.ok} ok · ${summary.warn} Warn · ${summary.error} Fehler`,
            );
        }
    }

    /**
     * The monetary result hero (design 01–03): left = label + big signed amount (amber = Nachzahlung,
     * green = Erstattung) + context; right = a mini-table of the key figures. Renders plan.summary
     * (raw numbers from the shared core) so the app + web show identical values.
     */
    private heroSummary(s: TaxReturnSummary): Gtk.Widget {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 16,
            marginTop: 16,
            marginBottom: 16,
            marginStart: 16,
            marginEnd: 16,
        });

        const left = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        left.append(new Gtk.Label({ label: s.primary.label, xalign: 0, cssClasses: ['dim-label', 'caption'] }));
        const accent = s.primary.kind === 'payment' ? 'warning' : 'success';
        left.append(
            new Gtk.Label({
                label: `${fmt(s.primary.amount)} €`,
                xalign: 0,
                cssClasses: ['title-1', 'numeric', accent],
            }),
        );
        left.append(new Gtk.Label({ label: s.context, xalign: 0, cssClasses: ['dim-label', 'caption'] }));
        content.append(left);

        const right = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER });
        for (const line of s.secondary) {
            const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 16 });
            row.append(
                new Gtk.Label({ label: line.label, xalign: 0, hexpand: true, cssClasses: ['dim-label', 'caption'] }),
            );
            row.append(
                new Gtk.Label({ label: `${fmt(line.amount)} €`, xalign: 1, cssClasses: ['numeric', 'caption'] }),
            );
            right.append(row);
        }
        content.append(right);

        const card = new Gtk.Box({ cssClasses: ['card'] });
        card.append(content);
        return card;
    }

    /** Prominent readiness banner (Adwaita `.card`). `ready` folds in the machine cross-check verdict. */
    private resultBanner(plan: TaxReturnPlan, ready: boolean, summary: CrossCheckSummary): Gtk.Widget {
        const exportable = plan.forms.filter((f) => f.canExport).length;
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        box.set_margin_top(14);
        box.set_margin_bottom(14);
        box.set_margin_start(16);
        box.set_margin_end(16);
        box.append(
            new Gtk.Label({ label: `Steuererklärung ${plan.year}`, xalign: 0, cssClasses: ['dim-label', 'caption'] }),
        );
        // Not-ready reads as a status, not neutral text: amber for open points, red once a cross-check
        // actually errored (the honest gate) — matching the app's warn/error colour semantics.
        const notReadyAccent = summary.error > 0 ? 'error' : 'warning';
        box.append(
            new Gtk.Label({
                label: ready ? '✓ Abgabebereit' : '⚠ Noch nicht abgabebereit',
                xalign: 0,
                cssClasses: ready ? ['title-2', 'success'] : ['title-2', notReadyAccent],
            }),
        );
        // The privat ESt now has an E10 XML export (buildEstEds) + Prüfblatt (loadEstPdf) and is in the
        // Absenden arc → direct filing via ERiC (Freigabe gate) OR the Prüf-PDF as the template for the
        // web form. The annual business forms (EÜR/USt-Jahr/GewSt/Feststellung) have NO Mein-ELSTER XML
        // import — only the USt-VA — there the Prüf-PDF is the template to type off.
        const subtitle = plan.est
            ? 'Schätzung — Prüf-PDF + E10-XML; Abgabe via ELSTER-Direktversand (Freigabe erforderlich) oder Web-Formular'
            : `${exportable}/${plan.forms.length} Formulare · Prüf-PDF als Vorlage — Werte in Mein ELSTER eintragen`;
        box.append(
            new Gtk.Label({
                label: subtitle,
                xalign: 0,
                wrap: true,
                cssClasses: ['dim-label', 'caption'],
            }),
        );
        // Surface the cross-check errors on the banner itself — the reason it is not abgabebereit.
        if (summary.error > 0) {
            box.append(
                new Gtk.Label({
                    label: `✗ ${summary.error} Querprüfung(en) mit Fehler — vor Abgabe klären.`,
                    xalign: 0,
                    wrap: true,
                    cssClasses: ['error', 'caption'],
                }),
            );
        }
        const card = new Gtk.Box({ cssClasses: ['card'] });
        card.append(box);
        return card;
    }

    /** The Steuer-Themen cards: one expander per theme (amount + refund impact + line items). */
    private estThemesGroup(themes: EstThemeCard[]): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Steuer-Themen', marginTop: 6 });
        for (const t of themes) {
            const row = new Adw.ExpanderRow({ title: markup(t.title), subtitle: markup(t.hint) });
            const s = THEME_STATUS[t.status];
            row.add_prefix(new Gtk.Image({ iconName: s.icon, cssClasses: s.css, valign: Gtk.Align.CENTER }));

            const suffix = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
            suffix.append(
                new Gtk.Label({
                    label: `${fmt(t.amount)} €`,
                    xalign: 1,
                    cssClasses: ['dim-label', 'caption', 'numeric'],
                }),
            );
            if (t.impact !== 0) {
                suffix.append(
                    amountLabel(`${t.impact >= 0 ? '+' : '−'}${fmt(Math.abs(t.impact))} €`, {
                        accent: t.impact >= 0 ? 'success' : 'error',
                    }),
                );
            }
            row.add_suffix(suffix);

            for (const it of t.items) {
                const line = new Adw.ActionRow({ title: markup(it.label) });
                line.add_suffix(
                    new Gtk.Label({
                        label: it.value,
                        xalign: 1,
                        cssClasses: ['dim-label', 'numeric'],
                        valign: Gtk.Align.CENTER,
                    }),
                );
                row.add_row(line);
            }
            group.add(row);
        }
        return group;
    }

    /** The Bruttoarbeitslohn → … → Erstattung waterfall as a read-only group. */
    private estWaterfallGroup(rows: EstWaterfallRow[]): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Berechnung', marginTop: 6 });
        for (const r of rows) {
            const row = new Adw.ActionRow({ title: markup(r.label) });
            if (r.emphasis) row.add_css_class('heading');
            const suffix =
                r.emphasis === 'result'
                    ? amountLabel(r.value, {
                          accent: r.value.trim().startsWith('+') ? 'success' : 'error',
                          heading: true,
                      })
                    : new Gtk.Label({
                          label: r.value,
                          cssClasses: r.emphasis === 'total' ? ['heading', 'numeric'] : ['dim-label', 'numeric'],
                          valign: Gtk.Align.CENTER,
                      });
            row.add_suffix(suffix);
            group.add(row);
        }
        return group;
    }

    /** One step's content page: its headline + detail rows (or the per-form Prüf-PDF previews).
     *  The Abgabe step additionally hosts the ELSTER submission chain (`submission`, v3 design). */
    private stepContent(
        step: WizardStep,
        plan: TaxReturnPlan,
        checks: CrossCheckResult[],
        summary: CrossCheckSummary,
        entity: AppEntity,
        year: number,
        submission: SubmissionSection | null = null,
    ): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, marginTop: 6 });

        // Gegenprüfung: the machine cross-checks are the substance (business entities). The wizard's
        // human-judgment reminders stay below as a secondary group; a `privat`/ESt entity has no
        // cross-checks (checks == []) and falls through to the plain details rendering.
        if (step.id === 'pruefung' && checks.length > 0) {
            const group = new Adw.PreferencesGroup({
                title: 'Querprüfungen',
                description: markup(this.verdictText(summary)),
            });
            for (const r of checks) group.add(this.crossCheckRow(r));
            box.append(group);
            if (step.details.length) {
                const manual = new Adw.PreferencesGroup({ title: 'Zusätzlich manuell prüfen', marginTop: 6 });
                for (const d of step.details) manual.add(new Adw.ActionRow({ title: markup(d) }));
                box.append(manual);
            }
            return box;
        }

        const group = new Adw.PreferencesGroup({ description: markup(step.headline ?? '') });
        if (step.id === 'formulare') {
            for (const f of plan.forms) group.add(this.formRow(f, entity, year));
        } else if (step.details.length) {
            for (const d of step.details) group.add(new Adw.ActionRow({ title: markup(d) }));
        } else {
            // A step with nothing to flag is a positive confirmation — mark it with an ok icon.
            const clear = new Adw.ActionRow({ title: 'Keine offenen Punkte in diesem Schritt.' });
            clear.add_prefix(
                new Gtk.Image({ iconName: 'emblem-ok-symbolic', cssClasses: ['success'], valign: Gtk.Align.CENTER }),
            );
            group.add(clear);
        }
        box.append(group);
        // "Hier beheben" deep-links (e.g. offene Buchungen → Buchungen-Ansicht) below the details.
        if (step.actions?.length) box.append(this.stepActions(step.actions));
        // Abgabe: the submission chain (Querprüfungen → Snapshot → Freigabe → Test → Versand).
        if (submission) box.append(submission.root);
        return box;
    }

    /**
     * A row of accent "hier beheben" buttons that deep-link to another top-level view. Each fires the
     * window's `win.navigate` action (see window.ts) with the target view id — it bubbles up the
     * widget tree, so no callback has to be threaded through the Steuer tab hub.
     */
    private stepActions(actions: NonNullable<WizardStep['actions']>): Gtk.Widget {
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.START,
            marginTop: 4,
        });
        for (const a of actions) {
            const btn = new Gtk.Button({ label: a.label, cssClasses: ['pill', 'suggested-action'] });
            btn.connect('clicked', () => navigateTo(this, a.view as NavViewId));
            bar.append(btn);
        }
        return bar;
    }

    /** One-line verdict for the Gegenprüfung group description, derived from the core summary. */
    private verdictText(s: CrossCheckSummary): string {
        const counts = `${s.ok} ok · ${s.warn} Warnung(en) · ${s.error} Fehler`;
        if (s.error > 0) return `${counts} — nicht abgabebereit, bis die Fehler geklärt sind.`;
        if (s.warn > 0) return `${counts} — Warnungen vor der Abgabe prüfen.`;
        return `${counts} — keine Abweichungen gefunden.`;
    }

    /**
     * One machine cross-check as an ActionRow: leading status glyph (colored), label as title, the
     * German detail + an `erwartet X · ist Y · Δ Z` line as subtitle. Renders a plain CrossCheckResult
     * from core — no check logic here.
     */
    private crossCheckRow(r: CrossCheckResult): Adw.ActionRow {
        const meta = CROSSCHECK_STATUS[r.status];
        const lines = [r.detail];
        if (r.expected != null || r.actual != null || r.delta != null) {
            const nums: string[] = [];
            if (r.expected != null) nums.push(`erwartet ${fmt(r.expected)} €`);
            if (r.actual != null) nums.push(`ist ${fmt(r.actual)} €`);
            if (r.delta != null) nums.push(`Δ ${fmt(r.delta)} €`);
            lines.push(nums.join(' · '));
        }
        const row = new Adw.ActionRow({ title: markup(r.label), subtitle: markup(lines.join('\n')) });
        row.set_subtitle_lines(0);
        row.add_prefix(
            new Gtk.Label({ label: meta.glyph, cssClasses: [meta.css, 'title-3'], valign: Gtk.Align.CENTER }),
        );
        return row;
    }

    private formRow(f: WizardFormPreview, entity: AppEntity, year: number): Adw.ActionRow {
        const row = new Adw.ActionRow({
            title: markup(f.title),
            subtitle: markup(f.figures.map((fig) => `${fig.label}: ${fig.value}`).join(' · ')),
        });
        if (f.canExport) {
            const btn = new Gtk.Button({
                iconName: 'document-save-symbolic',
                tooltipText: 'Prüf-Datenblatt als PDF speichern',
                cssClasses: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => void this.exportPdf(f, entity, year));
            row.add_suffix(btn);
        } else if (f.blockedReason) {
            row.add_suffix(new Gtk.Label({ label: f.blockedReason, cssClasses: ['dim-label'] }));
        }
        return row;
    }

    private async exportPdf(f: WizardFormPreview, entity: AppEntity, year: number): Promise<void> {
        const loader = PDF_LOADERS[f.form];
        if (!loader) return; // no Prüf-PDF for this form (e.g. USt-VA) — the export button isn't shown
        try {
            const { filename, bytes } = await loader(entity, year);
            saveFileViaDialog(this, filename, bytes, `${f.title}-Prüfblatt`);
        } catch (err) {
            await errorDialog(this, 'PDF nicht verfügbar', err instanceof Error ? err.message : String(err));
        }
    }
}
