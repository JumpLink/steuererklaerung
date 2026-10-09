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
import { promptLiveSend, promptRelease, promptTestSend } from './absenden-dialog.ts';
import { vorAbgabeGroup } from './vor-abgabe-group.ts';
import { showToast } from '../toast.ts';

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
    draft: { label: 'Entwurf', css: 'dim-label' },
    validated: { label: 'validiert (ERiC-Prüfung bestanden)', css: 'accent' },
    submitting: { label: 'Versand offen', css: 'warning' },
    submitted: { label: 'übermittelt', css: 'success' },
    superseded: { label: 'ersetzt', css: 'dim-label' },
};

function msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
                const group = new Adw.PreferencesGroup({ title: 'Absenden' });
                group.add(
                    new Adw.ActionRow({
                        title: 'Übersicht konnte nicht geladen werden',
                        subtitle: markup(msg(err)),
                    }),
                );
                this.root.append(group);
            });
    }

    private loadingRow(): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: 'Absenden' });
        const row = new Adw.ActionRow({ title: 'Übermittlungs-Status wird geladen …', cssClasses: ['dim-label'] });
        row.add_prefix(new Adw.Spinner({ valign: Gtk.Align.CENTER }));
        group.add(row);
        return group;
    }

    private fill(overview: SubmissionOverview): void {
        this.clear();
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
            title: 'Absenden',
            description:
                'Pro Formular: Snapshot erfassen → freigeben → testweise an ELSTER senden. Der Echt-Versand ' +
                'erfolgt separat mit deinem ELSTER-Zertifikat.',
        });
        const row = new Adw.ActionRow({
            title: 'ERiC (ELSTER Rich Client)',
            subtitle: overview.ericAvailable
                ? markup(`verfügbar${overview.ericVersion ? ` · Version ${overview.ericVersion}` : ''}`)
                : 'nicht verfügbar — in der Konten-Ansicht einrichten',
        });
        row.add_prefix(
            new Gtk.Image({
                iconName: overview.ericAvailable ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
                cssClasses: [overview.ericAvailable ? 'success' : 'warning'],
                valign: Gtk.Align.CENTER,
            }),
        );
        row.add_suffix(
            overview.ericAvailable
                ? statusPill({ icon: 'emblem-ok-symbolic', css: 'success', label: 'verfügbar' })
                : statusPill({ icon: 'dialog-warning-symbolic', css: 'warning', label: 'nicht verfügbar' }),
        );
        group.add(row);
        return group;
    }

    /** One form: state rows (snapshot / sign-off) + gate/blockers + the applicable action buttons. */
    private formGroup(form: FormSubmissionState, ericAvailable: boolean): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: markup(form.title) });
        group.set_header_suffix(
            form.gate.unlocked
                ? statusPill({ icon: 'emblem-ok-symbolic', css: 'success', label: '✓ freigeschaltet' })
                : statusPill({ icon: 'changes-prevent-symbolic', css: 'error', label: '✗ gesperrt' }),
        );

        // Stand — the immutable snapshot's status + drift.
        const snap = form.snapshot;
        const stand = new Adw.ActionRow({
            title: 'Stand',
            subtitle: markup(
                snap
                    ? `${SNAPSHOT_STATUS[snap.status].label}${form.stale ? ' · ⚠ veraltet' : ''} · ` +
                          `erfasst ${deDateTime(snap.createdAt)}`
                    : 'Kein Snapshot erfasst',
            ),
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
            title: 'Freigabe',
            subtitle: markup(form.signoffValid ? 'freigegeben' : (form.signoffReason ?? 'keine Freigabe')),
        });
        rel.set_subtitle_lines(0);
        rel.add_suffix(
            new Gtk.Label({
                label: form.signoffValid ? '✓ freigegeben' : '—',
                cssClasses: ['caption', form.signoffValid ? 'success' : 'dim-label'],
                valign: Gtk.Align.CENTER,
            }),
        );
        group.add(rel);

        // Gate — unlocked, or the German blockers spelled out (read-first: the reason is visible).
        if (form.gate.unlocked) {
            const ok = new Adw.ActionRow({ title: 'Absenden freigeschaltet' });
            ok.add_prefix(
                new Gtk.Image({ iconName: 'emblem-ok-symbolic', cssClasses: ['success'], valign: Gtk.Align.CENTER }),
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

        group.add(this.actionRow(form, ericAvailable));

        // Live send — intentionally not offered here; named so its absence is honest, not a gap.
        const live = new Adw.ActionRow({
            title: 'Echt-Versand',
            subtitle: 'separat, mit deinem ELSTER-Zertifikat — hier bewusst nicht angeboten.',
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
            const pdf = new Gtk.Button({ label: 'Prüf-PDF', cssClasses: ['flat'], valign: Gtk.Align.CENTER });
            pdf.set_tooltip_text('Prüf-Datenblatt als PDF speichern (vor der Freigabe gegenlesen)');
            pdf.connect('clicked', () => void this.onExportPdf(form, pdfLoader));
            box.append(pdf);
        }

        // Snapshot erfassen — always available (safe local write); re-capture supersedes the old one.
        const capture = new Gtk.Button({
            label: form.snapshot ? 'Neu erfassen' : 'Snapshot erfassen',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        capture.connect('clicked', () => void this.onCapture(form));
        box.append(capture);

        // Lokal prüfen — validate the snapshot against ERiC WITHOUT sending; promotes draft → validated
        // (the test-first gate a real/live artifact needs before a live send). Needs ERiC + a fresh draft.
        const canValidate = ericAvailable && !!form.snapshot && !form.stale && form.snapshot.status === 'draft';
        const validate = new Gtk.Button({
            label: 'Lokal prüfen',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canValidate,
        });
        validate.set_tooltip_text(
            canValidate
                ? 'Snapshot lokal gegen ERiC prüfen (kein Versand) — setzt bei Erfolg „validiert"'
                : !ericAvailable
                  ? 'ERiC nicht verfügbar'
                  : !form.snapshot
                    ? 'Zuerst einen Snapshot erfassen'
                    : form.stale
                      ? 'Snapshot veraltet — neu erfassen'
                      : 'Snapshot ist bereits validiert',
        );
        validate.connect('clicked', () => void this.onValidate(form));
        box.append(validate);

        // Freigeben — a snapshot must exist and be fresh, and not already validly released.
        const canRelease = !!form.snapshot && !form.stale && !form.signoffValid;
        const release = new Gtk.Button({
            label: 'Freigeben',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canRelease,
        });
        if (!canRelease) {
            release.set_tooltip_text(
                !form.snapshot
                    ? 'Zuerst einen Snapshot erfassen'
                    : form.stale
                      ? 'Snapshot veraltet — neu erfassen'
                      : 'Bereits freigegeben',
            );
        }
        release.connect('clicked', () => void this.onRelease(form));
        box.append(release);

        // Test senden — needs ERiC available and the structural test guards passed.
        const canTest = ericAvailable && form.testReady;
        const test = new Gtk.Button({
            label: 'Test senden',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canTest,
        });
        if (!canTest) {
            test.set_tooltip_text(
                !ericAvailable ? 'ERiC nicht verfügbar' : (form.testBlockers[0] ?? 'Test-Versand noch nicht möglich'),
            );
        }
        test.connect('clicked', () => void this.onTestSend(form));
        box.append(test);

        // Verbindlich absenden — the ONE irreversible step: a real filing to the Finanzamt. Enabled only
        // when the full live gate holds (valid sign-off + validated/test-first + Echt-Artefakt + not
        // already submitted); `liveReady` is precomputed with allowLive, so the button IS the opt-in.
        const canLive = ericAvailable && form.liveReady;
        const live = new Gtk.Button({
            label: 'Verbindlich absenden',
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            sensitive: canLive,
        });
        live.set_tooltip_text(
            canLive
                ? 'Verbindlich ans Finanzamt übermitteln (unwiderruflich)'
                : !ericAvailable
                  ? 'ERiC nicht verfügbar'
                  : form.snapshot?.status === 'submitted'
                    ? 'Bereits verbindlich übermittelt'
                    : (form.liveBlockers[0] ?? 'Echt-Versand noch nicht möglich'),
        );
        live.connect('clicked', () => void this.onLiveSend(form));
        box.append(live);

        row.add_suffix(box);
        return row;
    }

    // ── Actions (each reloads the section afterwards so the state reflects the write) ────────────────

    /** Render the form's Prüf-Datenblatt and Save-As. Read-only — no reload afterwards. */
    private async onExportPdf(form: FormSubmissionState, loader: PruefPdfLoader): Promise<void> {
        try {
            const { filename, bytes } = await loader(this.entity, this.year);
            saveFileViaDialog(this.root, filename, bytes, `${form.title}-Prüfblatt`);
        } catch (err) {
            await errorDialog(this.root, 'Prüf-PDF nicht verfügbar', msg(err));
        }
    }

    private async onCapture(form: FormSubmissionState): Promise<void> {
        try {
            await captureSnapshot(this.entity, this.year, form.form, form.period);
            showToast(`Snapshot erfasst: ${form.title}`);
        } catch (err) {
            await errorDialog(this.root, 'Snapshot fehlgeschlagen', msg(err));
        }
        this.reload();
    }

    private async onValidate(form: FormSubmissionState): Promise<void> {
        try {
            const result = await validateSnapshot(this.entity, this.year, form.form, form.period);
            if (result.ok) {
                showToast(`Lokal validiert: ${form.title}${result.hinweise ? ' (mit ERiC-Hinweisen)' : ''}`);
            } else {
                await errorDialog(this.root, 'ERiC-Validierung', result.message);
            }
        } catch (err) {
            await errorDialog(this.root, 'Validierung fehlgeschlagen', msg(err));
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
                showToast(`Freigegeben — aber ${cc.error} Querprüfung(en) mit Fehler; vor Abgabe klären.`, 6);
            } else if (cc) {
                showToast(`Freigegeben — Querprüfungen sauber (${cc.ok} ok · ${cc.warn} Warnung).`);
            } else {
                showToast(`Freigegeben: ${form.title}`);
            }
        } catch (err) {
            await errorDialog(this.root, 'Freigabe fehlgeschlagen', msg(err));
        }
        this.reload();
    }

    private async onTestSend(form: FormSubmissionState): Promise<void> {
        // Pre-fill the dialog from the entity's configured certificate + any keyring-stored PIN, and
        // offer to keep the PIN only when a keyring is reachable.
        const canSavePin = keyringAvailable();
        const creds = await promptTestSend(this.root, form.title, {
            keystorePath: loadKeystorePath(this.entity),
            pin: canSavePin ? (lookupElsterPin(this.entity.id) ?? undefined) : undefined,
            canSavePin,
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
                await errorDialog(this.root, 'Test-Versand', result.message);
            }
        } catch (err) {
            await errorDialog(this.root, 'Test-Versand fehlgeschlagen', msg(err));
        }
        this.reload();
    }

    private async onLiveSend(form: FormSubmissionState): Promise<void> {
        // A binding, irreversible filing. Collect creds behind the heavier promptLiveSend dialog (with the
        // headline figure for a final read); pre-fill path + keyring PIN like the test send. The PIN never
        // touches the shell/history — it stays in the masked field / the OS keyring.
        const canSavePin = keyringAvailable();
        const headline = (form.snapshot?.figures as { headline?: Record<string, number> } | null)?.headline;
        const erstattung = headline?.erstattung;
        const figure =
            typeof erstattung === 'number'
                ? `${erstattung >= 0 ? 'Erstattung' : 'Nachzahlung'}: ${eur(Math.abs(erstattung))}`
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
                    heading: 'Erfolgreich übermittelt',
                    body:
                        `„${form.title}“ ist verbindlich beim Finanzamt eingegangen.\n\n` +
                        `Transferticket: ${result.transferticket || '—'}`,
                });
                done.add_response('ok', 'OK');
                done.set_default_response('ok');
                done.present(this.root);
            } else {
                await errorDialog(this.root, 'Echt-Versand', result.message);
            }
        } catch (err) {
            await errorDialog(this.root, 'Echt-Versand fehlgeschlagen', msg(err));
        }
        this.reload();
    }
}
