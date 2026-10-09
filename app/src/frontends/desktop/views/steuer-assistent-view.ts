/**
 * BhSteuerAssistentView — the question-guided "Steuer-Assistent" for the private Einkommensteuer.
 *
 * The thin GUI seam over the tested intake topic registry ({@link INTAKE_TOPICS}): per topic
 * (§24b, Kinderbetreuung, Haushalts-Zeitachse, §32b Lohnersatz) it generically renders that topic's
 * question flow (branching via {@link aktiveFragen}), shows the pure {@link IntakeTopic.vorschau}
 * live and, on confirm, writes through {@link IntakeTopic.anwenden} (the existing `apply*` seam) +
 * drops the EÜR aggregate cache so the tax views recompute. No tax knowledge lives HERE — the view
 * knows only the four question types and delegates derivation/persistence to the core.
 *
 * GJS GUI → not verifiable headless (sandbox Exit 144); build-verified, visually by the user.
 */

import GObject from '@girs/gobject-2.0';
import type Gtk from '@girs/gtk-4.0';
import Adw from '@girs/adw-1';

import type { AppEntity } from '../entities.ts';
import { appSession } from '../data/session.ts';
import { INTAKE_TOPICS, type IntakeTopic, type IntakeContext } from '../../../core/actions/elster/est-intake-topics.ts';
import { aktiveFragen, type IntakeQuestion } from '../../../core/actions/elster/est-intake.ts';
import type { EstKind } from '../../../core/config/schema/est.ts';
import { comboRow, spinRow, toggleRow, type SettingsHost } from './einstellungen/rows.ts';

const MONATE = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
];

/** Display label for a child in a combo (Vorname, plus Nachname when set — the IdNr stays internal). */
function kindLabel(k: EstKind): string {
    return k.nachname ? `${k.vorname} ${k.nachname}` : k.vorname;
}

export class BhSteuerAssistentView extends Adw.Bin {
    private entity?: AppEntity;
    private year = 0;

    private readonly toast = new Adw.ToastOverlay();
    private page?: Adw.PreferencesPage;
    /** The swappable questions group for the active topic (rebuilt on topic/gate change). */
    private questionsGroup?: Adw.PreferencesGroup;
    private previewRow?: Adw.ActionRow;

    private topic: IntakeTopic = INTAKE_TOPICS[0];
    private answers: Record<string, unknown> = {};
    private kindIdnr?: string;
    /** True while programmatically populating rows — suppresses the row helpers' change→persist. */
    private filling = false;

    static {
        GObject.registerClass({ GTypeName: 'BhSteuerAssistentView' }, this);
    }

    constructor() {
        super();
        this.set_child(this.toast);
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        this.topic = INTAKE_TOPICS[0];
        this.answers = {};
        this.kindIdnr = undefined;
        this.buildPage();
    }

    /** Minimal SettingsHost for the row helpers — the wizard collects answers in memory (write on confirm). */
    private host(): SettingsHost {
        return {
            isFilling: () => this.filling,
            banner: () => {},
            saveWith: (fn) => fn(),
            // The wizard has no per-entity groups to rebuild — it collects answers in memory and
            // writes them on confirm, so there is nothing here that could go stale against the file.
            reloadEntityGroups: () => {},
        };
    }

    private get kinder(): EstKind[] {
        return this.entity?.est?.kinder ?? [];
    }

    private context(): IntakeContext {
        return { entityId: this.entity?.id ?? '', year: this.year, kindIdnr: this.kindIdnr };
    }

    // ── Page ──────────────────────────────────────────────────────────────────────────────────────

    private buildPage(): void {
        this.filling = true;
        const page = new Adw.PreferencesPage();

        const intro = new Adw.PreferencesGroup({
            title: 'Steuer-Assistent',
            description:
                'Beantworte ein paar Fragen in Klartext — der Assistent rechnet den Abzug aus und trägt ihn in deine Steuererklärung ein. Wähle ein Thema:',
        });
        const themen = INTAKE_TOPICS.map((t) => t.titel);
        const selektor = comboRow(this.host(), 'Thema', themen, INTAKE_TOPICS.indexOf(this.topic), (i) => {
            this.topic = INTAKE_TOPICS[i] ?? INTAKE_TOPICS[0];
            this.answers = {};
            this.kindIdnr = undefined;
            this.buildQuestions();
        });
        intro.add(selektor);
        page.add(intro);

        this.page = page;
        this.toast.set_child(page);
        this.buildQuestions();
        this.filling = false;
    }

    /** (Re)build the active topic's question group — called on topic change and on gate-answer change. */
    private buildQuestions(): void {
        if (!this.page) return;
        const wasFilling = this.filling;
        this.filling = true;
        if (this.questionsGroup) {
            this.page.remove(this.questionsGroup);
            this.questionsGroup = undefined;
        }
        const group = new Adw.PreferencesGroup({ title: this.topic.titel, description: this.topic.beschreibung });

        // Per-child topics: pick the child first (context); Übernehmen stays blocked until one is chosen.
        if (this.topic.proKind) group.add(this.kindContextRow());

        // Gate ids: questions whose answer decides whether OTHER questions are shown → rebuild on change.
        const gateIds = new Set(this.topic.fragen.filter((q) => q.wennId).map((q) => q.wennId as string));
        for (const q of aktiveFragen(this.topic.fragen, this.answers)) group.add(this.questionRow(q, gateIds));

        const preview = new Adw.ActionRow({ title: 'Vorschau', subtitleLines: 0 });
        this.previewRow = preview;
        group.add(preview);

        const uebernehmen = new Adw.ButtonRow({ title: 'Übernehmen' });
        uebernehmen.add_css_class('suggested-action');
        uebernehmen.connect('activated', () => this.uebernehmen());
        group.add(uebernehmen);

        this.page.add(group);
        this.questionsGroup = group;
        this.refreshPreview();
        this.filling = wasFilling;
    }

    /** The child selector for per-child topics (sets `this.kindIdnr` in the context). */
    private kindContextRow(): Adw.ComboRow {
        const optionen = ['— Kind wählen —', ...this.kinder.map(kindLabel)];
        const sel = this.kindIdnr ? this.kinder.findIndex((k) => k.idnr === this.kindIdnr) + 1 : 0;
        return comboRow(this.host(), 'Für welches Kind?', optionen, Math.max(0, sel), (i) => {
            this.kindIdnr = i > 0 ? this.kinder[i - 1]?.idnr : undefined;
            this.refreshPreview();
        });
    }

    /** One question → an Adwaita row by type; gate answers rebuild the flow, others just refresh preview. */
    private questionRow(q: IntakeQuestion, gateIds: Set<string>): Gtk.Widget {
        const changed = (value: unknown) => {
            this.answers[q.id] = value;
            if (gateIds.has(q.id)) this.buildQuestions();
            else this.refreshPreview();
        };

        if (q.typ === 'boolean') {
            return toggleRow(this.host(), q.frage, q.hilfe ?? null, this.answers[q.id] === true, (on) => changed(on));
        }

        if (q.typ === 'zahl') {
            const digits = q.nachkomma ?? 0;
            const row = spinRow(
                this.host(),
                q.frage,
                Number(this.answers[q.id] ?? 0),
                { digits, lower: 0, upper: digits > 0 ? 10_000_000 : 99 },
                (v) => changed(digits > 0 ? v : Math.round(v)),
            );
            if (q.hilfe) row.set_subtitle(q.hilfe);
            return row;
        }

        if (q.typ === 'monat') {
            const cur = typeof this.answers[q.id] === 'string' ? Number((this.answers[q.id] as string).slice(5, 7)) : 0;
            const row = comboRow(this.host(), q.frage, ['— (offen)', ...MONATE], cur >= 1 && cur <= 12 ? cur : 0, (i) =>
                changed(i === 0 ? undefined : `${this.year}-${String(i).padStart(2, '0')}`),
            );
            if (q.hilfe) row.set_subtitle(q.hilfe);
            return row;
        }

        if (q.typ === 'kind') {
            const optionen = ['—', ...this.kinder.map(kindLabel)];
            const sel = this.kinder.findIndex((k) => k.idnr === this.answers[q.id]) + 1;
            const row = comboRow(this.host(), q.frage, optionen, Math.max(0, sel), (i) =>
                changed(i > 0 ? this.kinder[i - 1]?.idnr : undefined),
            );
            if (q.hilfe) row.set_subtitle(q.hilfe);
            return row;
        }

        // 'auswahl' — seed the answer with the first option so the combo and the derive agree.
        const optionen = q.optionen ?? [];
        if (this.answers[q.id] === undefined && optionen[0]) this.answers[q.id] = optionen[0].wert;
        const sel = Math.max(
            0,
            optionen.findIndex((o) => o.wert === this.answers[q.id]),
        );
        const row = comboRow(
            this.host(),
            q.frage,
            optionen.map((o) => o.label),
            sel,
            (i) => changed(optionen[i]?.wert),
        );
        if (q.hilfe) row.set_subtitle(q.hilfe);
        return row;
    }

    // ── Vorschau + Übernehmen ───────────────────────────────────────────────────────────────────────

    private refreshPreview(): void {
        if (!this.previewRow) return;
        try {
            const v = this.topic.vorschau(this.answers, this.context());
            const lines = [v.ergebnis, ...v.hinweise.map((h) => `• ${h}`)];
            this.previewRow.set_subtitle(lines.join('\n'));
        } catch (err) {
            this.previewRow.set_subtitle(err instanceof Error ? err.message : String(err));
        }
    }

    private uebernehmen(): void {
        const entity = this.entity;
        if (!entity) return;
        if (this.topic.proKind && !this.kindIdnr) {
            this.notify_user('Bitte zuerst ein Kind wählen.');
            return;
        }
        try {
            const v = this.topic.anwenden(this.answers, this.context());
            appSession().invalidate(entity.id);
            this.notify_user(`✓ ${this.topic.titel}: ${v.ergebnis}`);
        } catch (err) {
            this.notify_user(err instanceof Error ? err.message : String(err));
        }
    }

    private notify_user(message: string): void {
        this.toast.add_toast(new Adw.Toast({ title: message, timeout: 4 }));
    }
}
