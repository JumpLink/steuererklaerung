/**
 * The Absenden (ELSTER submission) section of the Steuererklärung view — a self-contained,
 * self-reloading widget that renders "where is each return in the Absenden flow?" and drives the SAFE
 * steps from the GUI.
 *
 * It owns a root Gtk.Box (appended to the Steuererklärungs-Assistent's content, after the stepper) and
 * loads a {@link SubmissionOverview} independently of the plan (its own async probe, like the Konten
 * view's ERiC card), so an action just reloads THIS section. Per snapshot-able form it shows the
 * honest state FIRST — snapshot status + `⚠ veraltet`, sign-off `✓ freigegeben` / `—`, the submission
 * gate (`✓ freigeschaltet` / `✗ gesperrt` + the German blockers as rows) — then only the action
 * buttons that actually apply:
 *
 *   - "Snapshot erfassen"  → a safe local capture, then reload.
 *   - "Freigeben"          → records the human release (with an optional note), then reload.
 *   - "Test senden"        → opens the credentials dialog; only its explicit "Test senden" fires the
 *                            test transmission (Testmerker, discarded at the clearing house). Disabled
 *                            unless ERiC is available AND the form is test-ready.
 *
 * A live send is deliberately NOT offered here (it needs the real certificate + is a separate careful
 * step); an informational row names it. All state/gating comes from core (data/submission.ts) — this
 * file is widgets only. Above the forms, „Vor der Abgabe klären" (vor-abgabe-group.ts) lists the open
 * double payments and the Prüfungen vor der Abgabe with their bookings and actions — a warning, no gate.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    captureSnapshot,
    keyringAvailable,
    loadKeystorePath,
    loadSubmissionOverview,
    lookupElsterPin,
    releaseSignoff,
    sendLive,
    sendTest,
    storeElsterPin,
    validateSnapshot,
    type FilingSnapshot,
    type FilingFormType,
    type FormSubmissionState,
    type SubmissionOverview,
    type SubmissionTarget,
    ustvaPortalXml,
} from '../data/submission.ts';
import type { AppEntity } from '../entities.ts';
import { appSession } from '../data/session.ts';
import {
    loadEstPdf,
    loadEuerPdf,
    loadFeststellungPdf,
    loadGewstPdf,
    loadUstePdf,
} from '../../../core/presenters/steuer.ts';
import { doppelzahlungHinweisCounts } from '../../../core/actions/invoices/doppelzahlung.ts';
import { loadVorAbgabeHinweise, type YearHinweis } from '../../../core/presenters/hinweise.ts';
import { abgabeWarnungen } from '../../../core/invoices/doppelzahlung-text.ts';
import { deDateTime, eur } from '../../../core/lib/format.ts';
import { LoadToken, applyScrollToHook, currentOperator, markup, saveFileViaDialog } from './util.ts';
import { errorDialog } from './dialogs.ts';
import { ericPlatformSupported } from '../../../core/actions/elster/eric-status.ts';
import { ericVersionLabel } from '../../../core/actions/elster/eric-warnings.ts';
import { ericWarningMessage, ericWarningRow } from './eric-warning-rows.ts';
import { showSupportPrompt } from './support-dialog.ts';
import { claimSupportPrompt } from '../../../core/config/support-prompt.ts';
import { promptLiveSend, promptRelease, promptTestSend } from './absenden-dialog.ts';
import { ensurePrivacyAck } from './datenschutz-dialog.ts';
import { vorAbgabeGroup } from './vor-abgabe-group.ts';
import { showToast } from '../toast.ts';
import { _, _n, _p, fmt } from '../i18n.ts';
import { errorText } from '../error-text.ts';

/** Per-form Prüf-Datenblatt loader (byte-producing) — the same presenters the Steuer + Wizard views
 * use, so the Absenden section can offer a "Prüf-PDF" for a final read right next to Freigeben. No
 * loader for `ustva` (its Prüfblatt/flow lives elsewhere), so its button is simply not shown. */
type PruefPdfLoader = (entity: AppEntity, year: number) => Promise<{ filename: string; bytes: Uint8Array }>;
const PRUEF_PDF_LOADERS: Partial<Record<FilingFormType, PruefPdfLoader>> = {
    est: (e, y) => loadEstPdf(appSession(), e, y),
    euer: (e, y) => loadEuerPdf(appSession(), e, y),
    uste: (e, y) => loadUstePdf(appSession(), e, y),
    gewst: (e, y) => loadGewstPdf(appSession(), e, y),
    feststellung: (e, y) => loadFeststellungPdf(appSession(), e, y),
};

/** Label + accent per immutable-snapshot status. */
const SNAPSHOT_STATUS: Record<FilingSnapshot['status'], { label: string; css: string }> = {
    draft: { label: _('Draft'), css: 'dim-label' },
    validated: { label: _('validated (passed the ERiC check)'), css: 'accent' },
    submitting: { label: _('submission open'), css: 'warning' },
    submitted: { label: _('submitted'), css: 'success' },
    superseded: { label: _('superseded'), css: 'dim-label' },
};

function msg(err: unknown): string {
    return errorText(err);
}

/** A small status pill (icon + accented caption) — shared by the ERiC row and the per-form gate. */
function statusPill(opts: { icon: string; css: 'success' | 'warning' | 'error'; label: string }): Gtk.Box {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER });
    box.append(new Gtk.Image({ iconName: opts.icon, cssClasses: [opts.css] }));
    box.append(new Gtk.Label({ label: opts.label, cssClasses: ['caption', 'heading', opts.css] }));
    return box;
}

export class SubmissionSection {
    /** The section root — the Steuererklärung view appends this to its content box. */
    readonly root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });

    private entity!: AppEntity;
    private year = 0;
    private targets: readonly SubmissionTarget[] = [];
    /** Year-wide double-payment warnings shown above every form — fail-soft, empty when nothing is open. */
    private warnings: string[] = [];
    /** The Prüfungen vor der Abgabe + Geld-Prüfungen' warnings with a finding (Idee 10) — fail-soft too. */
    private hinweise: YearHinweis[] = [];
    private ericBundled = false;
    private readonly token = new LoadToken();

    /** (Re)load the overview for entity/year/targets and rebuild. Also the after-action refresh. */
    load(entity: AppEntity, year: number, targets: readonly SubmissionTarget[]): void {
        this.entity = entity;
        this.year = year;
        this.targets = targets;
        this.reload();
    }

    private clear(): void {
        let child = this.root.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.root.remove(child);
            child = next;
        }
    }

    private reload(): void {
        this.clear();
        this.root.append(this.loadingRow());
        const token = this.token.next();
        Promise.resolve()
            .then(async () => {
                const overview = await loadSubmissionOverview(this.entity, this.year, this.targets);
                const counts = await doppelzahlungHinweisCounts(this.entity.id, this.year);
                const hinweise = await loadVorAbgabeHinweise(appSession(), this.entity, this.year).catch(
                    (err: unknown) => {
                        console.error(`[app] Vor der Abgabe: ${msg(err)}`);
                        return [];
                    },
                );
                return { overview, warnings: abgabeWarnungen(counts), hinweise };
            })
            .then(({ overview, warnings, hinweise }) => {
                if (token !== this.token.current) return; // superseded by a newer reload
                this.warnings = warnings;
                this.hinweise = hinweise;
                this.fill(overview);
            })
            .catch((err: unknown) => {
                if (token !== this.token.current) return;
                console.error(`[app] Absenden-Übersicht: ${msg(err)}`);
                this.clear();
                const group = new Adw.PreferencesGroup({ title: _('Submit') });
                group.add(
                    new Adw.ActionRow({
                        title: _('Could not load the overview'),
                        subtitle: markup(msg(err)),
                    }),
                );
                this.root.append(group);
            });
    }

    private loadingRow(): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: _('Submit') });
        const row = new Adw.ActionRow({ title: _('Loading the submission status …'), cssClasses: ['dim-label'] });
        row.add_prefix(new Adw.Spinner({ valign: Gtk.Align.CENTER }));
        group.add(row);
        return group;
    }

    private fill(overview: SubmissionOverview): void {
        this.clear();
        this.ericBundled = overview.ericBundled;
        this.root.append(this.ericGroup(overview));
        const klaeren = vorAbgabeGroup(
            this.root,
            { entity: this.entity, year: this.year, onChanged: () => this.reload() },
            this.hinweise,
            this.warnings,
        );
        if (klaeren) {
            this.root.append(klaeren);
            applyScrollToHook(klaeren, 'vor-abgabe');
        }
        for (const form of overview.forms) this.root.append(this.formGroup(form, overview.ericAvailable));
    }

    /** ERiC availability + version — a form can't be sent without it (set up in the Konten-Ansicht). */
    private ericGroup(overview: SubmissionOverview): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: _('Submit'),
            description: _(
                'Per form: capture a snapshot → release it → send it to ELSTER as a test. The live submission happens separately, with your ELSTER certificate.',
            ),
        });
        const row = new Adw.ActionRow({
            title: 'ERiC (ELSTER Rich Client)',
            subtitle: overview.ericAvailable
                ? markup(
                      overview.ericVersion
                          ? `${_('available')} · ${ericVersionLabel(overview.ericVersion)}`
                          : _('available'),
                  )
                : ericPlatformSupported()
                  ? _('not available — set it up in the accounts view')
                  : _('there is no ERiC for this architecture — upload the XML in Mein ELSTER'),
        });
        row.add_prefix(
            new Gtk.Image({
                iconName: overview.ericAvailable ? 'object-select-symbolic' : 'dialog-warning-symbolic',
                cssClasses: [overview.ericAvailable ? 'success' : 'warning'],
                valign: Gtk.Align.CENTER,
            }),
        );
        row.add_suffix(
            overview.ericAvailable
                ? statusPill({ icon: 'object-select-symbolic', css: 'success', label: _('available') })
                : statusPill({ icon: 'dialog-warning-symbolic', css: 'warning', label: _('not available') }),
        );
        group.add(row);
        if (!overview.ericAvailable) {
            const fallback = new Adw.ActionRow({
                title: _('Without ERiC: upload the XML yourself'),
                subtitle: _(
                    'The USt-VA XML can be saved below and uploaded in Mein ELSTER (XML import). The annual returns are typed into the Mein ELSTER forms — use the check PDF as the template.',
                ),
            });
            fallback.set_subtitle_lines(0);
            fallback.add_prefix(new Gtk.Image({ iconName: 'document-save-symbolic', valign: Gtk.Align.CENTER }));
            group.add(fallback);
        }
        for (const warning of overview.ericWarnings) group.add(ericWarningRow(warning, overview.ericBundled));
        return group;
    }

    /** One form: state rows (snapshot / sign-off) + gate/blockers + the applicable action buttons. */
    private formGroup(form: FormSubmissionState, ericAvailable: boolean): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: markup(form.title) });
        group.set_header_suffix(
            form.gate.unlocked
                ? statusPill({ icon: 'object-select-symbolic', css: 'success', label: _('✓ unlocked') })
                : statusPill({ icon: 'changes-prevent-symbolic', css: 'error', label: _('✗ locked') }),
        );

        // Stand — the immutable snapshot's status + drift.
        const snap = form.snapshot;
        // Each flag is its own phrase — a translator cannot place a sub-clause through a placeholder.
        const standParts = snap
            ? [
                  SNAPSHOT_STATUS[snap.status].label,
                  ...(form.stale ? [_('⚠ outdated')] : []),
                  fmt(_('captured {when}'), { when: deDateTime(snap.createdAt) }),
              ]
            : [_('No snapshot captured')];
        const stand = new Adw.ActionRow({
            title: _('State'),
            subtitle: markup(standParts.join(' · ')),
        });
        stand.set_subtitle_lines(0);
        stand.add_suffix(
            snap
                ? new Gtk.Label({
                      label: SNAPSHOT_STATUS[snap.status].label,
                      cssClasses: ['caption', SNAPSHOT_STATUS[snap.status].css],
                      valign: Gtk.Align.CENTER,
                  })
                : new Gtk.Label({ label: '—', cssClasses: ['dim-label'], valign: Gtk.Align.CENTER }),
        );
        group.add(stand);

        // Freigabe — the human release (valid ⟺ non-revoked, bound to the latest snapshot, no drift).
        const rel = new Adw.ActionRow({
            title: _('Release'),
            subtitle: markup(form.signoffValid ? _('released') : (form.signoffReason ?? _('no release'))),
        });
        rel.set_subtitle_lines(0);
        rel.add_suffix(
            new Gtk.Label({
                label: form.signoffValid ? _('✓ released') : '—',
                cssClasses: ['caption', form.signoffValid ? 'success' : 'dim-label'],
                valign: Gtk.Align.CENTER,
            }),
        );
        group.add(rel);

        // Gate — unlocked, or the German blockers spelled out (read-first: the reason is visible).
        if (form.gate.unlocked) {
            const ok = new Adw.ActionRow({ title: _('Submission unlocked') });
            ok.add_prefix(
                new Gtk.Image({
                    iconName: 'object-select-symbolic',
                    cssClasses: ['success'],
                    valign: Gtk.Align.CENTER,
                }),
            );
            group.add(ok);
        } else {
            for (const blocker of form.gate.blockers) {
                const row = new Adw.ActionRow({ title: markup(blocker), cssClasses: ['dim-label'] });
                row.set_title_lines(0);
                row.add_prefix(
                    new Gtk.Image({
                        iconName: 'dialog-error-symbolic',
                        cssClasses: ['error'],
                        valign: Gtk.Align.CENTER,
                    }),
                );
                group.add(row);
            }
        }

        // Only the missing plugin belongs to this form; the runtime's own age is in the ERiC group.
        for (const warning of form.ericWarnings) {
            if (warning.kind === 'missing-plugin') group.add(ericWarningRow(warning, this.ericBundled));
        }

        group.add(this.actionRow(form, ericAvailable));

        // Live send — intentionally not offered here; named so its absence is honest, not a gap.
        const live = new Adw.ActionRow({
            title: _('Live submission'),
            subtitle: _('separate, with your ELSTER certificate — deliberately not offered here.'),
            cssClasses: ['dim-label'],
        });
        live.add_prefix(
            new Gtk.Image({ iconName: 'security-high-symbolic', cssClasses: ['dim-label'], valign: Gtk.Align.CENTER }),
        );
        group.add(live);

        return group;
    }

    /** The per-form action row: only the buttons whose action currently applies are enabled. */
    private actionRow(form: FormSubmissionState, ericAvailable: boolean): Adw.ActionRow {
        // No title. Six buttons ask for more width than the row has once the assistant panel is
        // docked, and GTK took it out of the TITLE: "Aktionen" wrapped to one character per line
        // ("A-k-t-i-o-n-e-n"), and forcing one line turned it into a bare "…". A label that renders
        // as three dots is worse than none — the buttons say what they do, and the group above says
        // which form they belong to.
        const row = new Adw.ActionRow({ title: '' });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            hexpand: true,
            halign: Gtk.Align.START,
        });

        // Prüf-PDF — the Prüf-Datenblatt for a final read BEFORE Freigabe, right where the actions are
        // (the same PDF the Steuer/Wizard views export). Shown for every form that has a loader.
        const pdfLoader = PRUEF_PDF_LOADERS[form.form];
        if (pdfLoader) {
            const pdf = new Gtk.Button({ label: _('Check PDF'), cssClasses: ['flat'], valign: Gtk.Align.CENTER });
            pdf.set_tooltip_text(_('Save the check sheet as a PDF (read it through before the release)'));
            pdf.connect('clicked', () => void this.onExportPdf(form, pdfLoader));
            box.append(pdf);
        }

        // Snapshot erfassen — always available (safe local write); re-capture supersedes the old one.
        const capture = new Gtk.Button({
            label: form.snapshot ? _('Capture again') : _('Capture snapshot'),
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        capture.connect('clicked', () => void this.onCapture(form));
        box.append(capture);

        // Lokal prüfen — validate the snapshot against ERiC WITHOUT sending; promotes draft → validated
        // (the test-first gate a real/live artifact needs before a live send). Needs ERiC + a fresh draft.
        const canValidate = ericAvailable && !!form.snapshot && !form.stale && form.snapshot.status === 'draft';
        const validate = new Gtk.Button({
            label: _('Check locally'),
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canValidate,
        });
        validate.set_tooltip_text(
            canValidate
                ? _('Check the snapshot locally against ERiC (no submission) — on success it is set to “validated”')
                : !ericAvailable
                  ? _('ERiC not available')
                  : !form.snapshot
                    ? _('Capture a snapshot first')
                    : form.stale
                      ? _('Snapshot outdated — capture it again')
                      : _('The snapshot is already validated'),
        );
        validate.connect('clicked', () => void this.onValidate(form));
        box.append(validate);

        // Freigeben — a snapshot must exist and be fresh, and not already validly released.
        const canRelease = !!form.snapshot && !form.stale && !form.signoffValid;
        const release = new Gtk.Button({
            label: _p('button', 'Release'),
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canRelease,
        });
        if (!canRelease) {
            release.set_tooltip_text(
                !form.snapshot
                    ? _('Capture a snapshot first')
                    : form.stale
                      ? _('Snapshot outdated — capture it again')
                      : _('Already released'),
            );
        }
        release.connect('clicked', () => void this.onRelease(form));
        box.append(release);

        // Test senden — needs ERiC available and the structural test guards passed.
        const canTest = ericAvailable && form.testReady;
        const test = new Gtk.Button({
            label: _('Send a test'),
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canTest,
        });
        if (!canTest) {
            test.set_tooltip_text(
                !ericAvailable
                    ? _('ERiC not available')
                    : (form.testBlockers[0] ?? _('A test submission is not possible yet')),
            );
        }
        test.connect('clicked', () => void this.onTestSend(form));
        box.append(test);

        // Verbindlich absenden — the ONE irreversible step: a real filing to the Finanzamt. Enabled only
        // when the full live gate holds (valid sign-off + validated/test-first + Echt-Artefakt + not
        // already submitted); `liveReady` is precomputed with allowLive, so the button IS the opt-in.
        const canLive = ericAvailable && form.liveReady;
        const live = new Gtk.Button({
            label: _('Submit bindingly'),
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canLive,
        });
        live.set_tooltip_text(
            canLive
                ? _('Transmit bindingly to the Finanzamt (irreversible)')
                : !ericAvailable
                  ? _('ERiC not available')
                  : form.snapshot?.status === 'submitted'
                    ? _('Already submitted bindingly')
                    : (form.liveBlockers[0] ?? _('A live submission is not possible yet')),
        );
        live.connect('clicked', () => void this.onLiveSend(form));
        box.append(live);

        // Without ERiC nothing can be sent from here: the way out is the XML, uploaded in Mein ELSTER.
        if (!ericAvailable && form.form === 'ustva') {
            const xml = new Gtk.Button({
                label: _('Save XML for Mein ELSTER'),
                cssClasses: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            xml.set_tooltip_text(
                _('Save the XML, then upload it in Mein ELSTER — no ERiC or Hersteller-ID needed on your side'),
            );
            xml.connect('clicked', () => void this.onExportXml(form));
            box.append(xml);
        }

        row.add_suffix(box);
        return row;
    }

    // ── Actions (each reloads the section afterwards so the state reflects the write) ────────────────

    /** Render the form's Prüf-Datenblatt and Save-As. Read-only — no reload afterwards. */
    private async onExportPdf(form: FormSubmissionState, loader: PruefPdfLoader): Promise<void> {
        try {
            const { filename, bytes } = await loader(this.entity, this.year);
            saveFileViaDialog(this.root, filename, bytes, fmt(_('{form} check sheet'), { form: form.title }));
        } catch (err) {
            await errorDialog(this.root, _('Check PDF not available'), msg(err));
        }
    }

    /** Save the XML for the Mein-ELSTER upload (the no-ERiC path). Read-only — no reload afterwards. */
    private async onExportXml(form: FormSubmissionState): Promise<void> {
        try {
            const { filename, bytes } = await ustvaPortalXml(this.entity, this.year, form.period);
            saveFileViaDialog(this.root, filename, bytes, fmt(_('{form} XML'), { form: form.title }));
        } catch (err) {
            await errorDialog(this.root, _('XML not available'), msg(err));
        }
    }

    private async onCapture(form: FormSubmissionState): Promise<void> {
        try {
            await captureSnapshot(this.entity, this.year, form.form, form.period);
            showToast(fmt(_('Snapshot captured: {form}'), { form: form.title }));
        } catch (err) {
            await errorDialog(this.root, _('Snapshot failed'), msg(err));
        }
        this.reload();
    }

    private async onValidate(form: FormSubmissionState): Promise<void> {
        try {
            const result = await validateSnapshot(this.entity, this.year, form.form, form.period);
            if (result.ok) {
                const done = fmt(_('Validated locally: {form}'), { form: form.title });
                showToast(result.hinweise ? `${done} ${_('(with ERiC notices)')}` : done);
            } else {
                await errorDialog(this.root, _('ERiC validation'), result.message);
            }
        } catch (err) {
            await errorDialog(this.root, _('Validation failed'), msg(err));
        }
        this.reload();
    }

    private async onRelease(form: FormSubmissionState): Promise<void> {
        const note = await promptRelease(this.root, form.title);
        if (note === null) return; // cancelled
        try {
            const result = await releaseSignoff(this.entity, this.year, form.form, {
                period: form.period,
                note: note || undefined,
                signedBy: currentOperator(),
            });
            const cc = result.crossChecks?.summary;
            if (cc && !cc.clean) {
                showToast(
                    fmt(
                        _n(
                            'Released — but {n} cross-check has an error; clear it before filing.',
                            'Released — but {n} cross-checks have errors; clear them before filing.',
                            cc.error,
                        ),
                        { n: cc.error },
                    ),
                    6,
                );
            } else if (cc) {
                showToast(
                    fmt(_('Released — cross-checks clean ({ok} ok · {warn} warning).'), { ok: cc.ok, warn: cc.warn }),
                );
            } else {
                showToast(fmt(_('Released: {form}'), { form: form.title }));
            }
        } catch (err) {
            await errorDialog(this.root, _('Release failed'), msg(err));
        }
        this.reload();
    }

    private ericNotices(form: FormSubmissionState): string[] {
        return form.ericWarnings.map((w) => ericWarningMessage(w, this.ericBundled));
    }

    private async onTestSend(form: FormSubmissionState): Promise<void> {
        if (!(await ensurePrivacyAck(this.root))) return; // licence § 5: before the first send
        // Pre-fill the dialog from the entity's configured certificate + any keyring-stored PIN, and
        // offer to keep the PIN only when a keyring is reachable.
        const canSavePin = keyringAvailable();
        const creds = await promptTestSend(this.root, form.title, {
            keystorePath: loadKeystorePath(this.entity),
            pin: canSavePin ? (lookupElsterPin(this.entity.id) ?? undefined) : undefined,
            canSavePin,
            ericNotices: this.ericNotices(form),
        });
        if (!creds) return; // cancelled — nothing is ever sent without the explicit "Test senden"
        try {
            const result = await sendTest(this.entity, this.year, form.form, creds, form.period);
            showToast(result.message, 6);
            if (result.ok) {
                // Persist the PIN ONLY after a successful test proved it correct — a wrong PIN fails
                // the send, so we never store (and later pre-fill) a bad one.
                if (creds.savePin) storeElsterPin(this.entity.id, creds.pin);
            } else {
                await errorDialog(this.root, _('Test submission'), result.message);
            }
        } catch (err) {
            await errorDialog(this.root, _('Test submission failed'), msg(err));
        }
        this.reload();
    }

    private async onLiveSend(form: FormSubmissionState): Promise<void> {
        if (!(await ensurePrivacyAck(this.root))) return; // licence § 5: before the first send
        // A binding, irreversible filing. Collect creds behind the heavier promptLiveSend dialog (with the
        // headline figure for a final read); pre-fill path + keyring PIN like the test send. The PIN never
        // touches the shell/history — it stays in the masked field / the OS keyring.
        const canSavePin = keyringAvailable();
        const headline = (form.snapshot?.figures as { headline?: Record<string, number> } | null)?.headline;
        const erstattung = headline?.erstattung;
        const figure =
            typeof erstattung === 'number'
                ? `${erstattung >= 0 ? _('Refund') : _('Additional payment')}: ${eur(Math.abs(erstattung))}`
                : undefined;
        // The open double-payment cases and the findings to clear ride along into the final read — a
        // warning, not a block.
        const summary =
            [figure, ...this.warnings.map((w) => `⚠ ${w}`), ...this.hinweise.map((h) => `⚠ ${h.title}`)]
                .filter(Boolean)
                .join('\n') || undefined;
        const creds = await promptLiveSend(
            this.root,
            form.title,
            {
                keystorePath: loadKeystorePath(this.entity),
                pin: canSavePin ? (lookupElsterPin(this.entity.id) ?? undefined) : undefined,
                canSavePin,
                ericNotices: this.ericNotices(form),
            },
            summary,
        );
        if (!creds) return; // cancelled — nothing is ever sent without the explicit "Jetzt verbindlich senden"
        try {
            const result = await sendLive(this.entity, this.year, form.form, creds, form.period);
            if (result.ok) {
                // Persist the PIN ONLY after a successful send proved it correct.
                if (creds.savePin) storeElsterPin(this.entity.id, creds.pin);
                const done = new Adw.AlertDialog({
                    heading: _('Successfully submitted'),
                    body:
                        fmt(_('“{form}” has arrived bindingly at the Finanzamt.'), { form: form.title }) +
                        '\n\n' +
                        fmt(_('Transfer ticket: {ticket}'), { ticket: result.transferticket || '—' }),
                });
                done.add_response('ok', 'OK');
                done.set_default_response('ok');
                done.set_close_response('ok');
                // Only after this one is dismissed, so the thank-you never stacks on the confirmation.
                done.connect('response', () => {
                    if (claimSupportPrompt(this.year)) void showSupportPrompt(this.root);
                });
                done.present(this.root);
            } else {
                await errorDialog(this.root, _('Live submission'), result.message);
            }
        } catch (err) {
            await errorDialog(this.root, _('Live submission failed'), msg(err));
        }
        this.reload();
    }
}
