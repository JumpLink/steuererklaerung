/**
 * <BhEinstellungenView> — the Einstellungen view: VIEW + EDIT the tax/config values that otherwise
 * live only in the gitignored JSON (steuererklaerung.json + the per-entity elster/est config).
 *
 * Two layers:
 * - GLOBAL (built once): the built-in assistant toggle + MCP exposure (master · allow-write · per
 *   group), persisted to steuererklaerung.json via saveAppSettings — a save failure surfaces in the banner.
 * - PER-ENTITY (rebuilt on every reload, gated by the active entity): Beleg-Verwaltung + Rechnung­stellung
 *   for every entity; Betrieb + Umsatzsteuer + Jahresabschluss-Anpassungen for business entities
 *   (hasElster); Person + Lohnsteuerbescheinigung + Vorsorge + Werbungskosten + Entlastungsbetrag
 *   (§24b) for the privat entity (hasEst, for the ACTIVE YEAR).
 *
 * The shell owns the view class + nav wiring, the global rows, and the per-entity orchestration; each
 * per-entity SECTION is a module under ./einstellungen/ (dms-invoicing · betrieb-ust · abschluss ·
 * privat) that builds its groups through the shared {@link SettingsHost} save contract. All edits go
 * through the data/settings.ts wrappers (never core directly). A programmatic fill must not persist —
 * it is guarded by `_filling`. After an est/elster save the shared EÜR aggregate cache is dropped so
 * the tax views recompute; a failure shows in the banner (never crashes), a success toasts.
 */

import { engineStatus, probeEngine, type EngineStatus } from '../../../core/actions/assistant/engine-status.ts';
import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './einstellungen-view.blp';
import {
    MCP_GROUPS,
    manifestRevision,
    loadSettings,
    saveSettings,
    loadElster,
    loadEst,
    type AppSettings,
    type McpGroup,
} from '../data/settings.ts';
import { appSession } from '../data/session.ts';
import type { AppEntity } from '../entities.ts';
import { applyScrollHook, markup } from './util.ts';
import { showToast } from '../toast.ts';
import type { SettingsHost } from './einstellungen/rows.ts';
import { buildDmsGroup, buildInvoicingGroup } from './einstellungen/dms-invoicing.ts';
import { buildBelegeMailGroup } from './einstellungen/belege-mail.ts';
import { buildBackupGroup, buildGeneralGroup } from './einstellungen/allgemein.ts';
import { buildMailGroup } from './einstellungen/mail-versand.ts';
import { buildMailTemplatesGroup } from './einstellungen/mail-vorlagen.ts';
import { buildKinderGroup } from './einstellungen/kinder.ts';
import { buildKlassifizierungGroup } from './einstellungen/klassifizierung.ts';
import { buildBetriebGroup, buildUstGroup } from './einstellungen/betrieb-ust.ts';
import { buildAufgabeGroup, buildGewerbeGroup } from './einstellungen/gewerbe-aufgabe.ts';
import { buildAnlagenGroup, buildPrivatanteileGroup, buildSonderbetriebGroup } from './einstellungen/abschluss.ts';
import {
    buildPersonGroup,
    buildLohnGroup,
    buildVorsorgeGroup,
    buildAbzuegeGroup,
    buildWerbungGroup,
    buildEntlastungGroup,
} from './einstellungen/privat.ts';
import { _, _p, fmt } from '../i18n.ts';

const GROUP_LABEL: Record<McpGroup, string> = {
    paperless: 'Paperless (DMS)',
    qonto: 'Qonto (Bank)',
    transactions: _p('MCP tool group', 'Transactions'),
    reconcile: _p('auto-matching', 'Matching'),
    documentWorkflow: _('Document workflow'),
    crossSystem: 'Cross-System',
    elster: 'ELSTER',
    invoices: _('Invoices (self)'),
    contacts: _('Contacts'),
};

export class BhEinstellungenView extends Adw.Bin {
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _save_banner: Adw.Banner;
    declare private _general_group: Adw.PreferencesGroup;
    declare private _backup_group: Adw.PreferencesGroup;
    declare private _entity_groups: Gtk.Box;
    declare private _lernmodus_group: Adw.PreferencesGroup;
    declare private _sync_group: Adw.PreferencesGroup;
    declare private _assistant_group: Adw.PreferencesGroup;
    declare private _mcp_group: Adw.PreferencesGroup;
    declare private _groups_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhEinstellungenView',
                Template,
                InternalChildren: [
                    'scroller',
                    'save_banner',
                    'general_group',
                    'backup_group',
                    'entity_groups',
                    'lernmodus_group',
                    'sync_group',
                    'assistant_group',
                    'mcp_group',
                    'groups_group',
                ],
            },
            this,
        );
    }

    private settings: AppSettings | null = null;
    private globalBuilt = false;
    private userBuilt = false;
    private entity: AppEntity | null = null;
    private year = new Date().getFullYear();
    /** True while programmatically populating rows — suppresses the notify/apply-driven persist. */
    private filling = false;
    /** Manifest state the entity groups were filled from — see the staleness guard in saveWith. */
    private revision: string | null = null;

    /** The save/banner/filling seam the per-entity section modules build through. */
    private readonly host: SettingsHost = {
        isFilling: () => this.filling,
        banner: (message) => this.banner(message),
        saveWith: (fn, opts) => this.saveWith(fn, opts),
        reloadEntityGroups: () => {
            if (this.entity) this.buildEntityGroups(this.entity, this.year);
        },
    };

    /**
     * Reload for the active entity/year: build the global rows once, then (re)build the per-entity
     * groups. Settings are global; the config groups are entity/year scoped, so they rebuild each time.
     */
    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        if (!this.userBuilt) {
            // Independent of the manifest — see einstellungen/allgemein.ts.
            buildGeneralGroup(this._general_group);
            buildBackupGroup(this._backup_group);
            this.userBuilt = true;
        }
        this.buildGlobalRows();
        this.buildEntityGroups(entity, year);
        applyScrollHook(this._scroller);
    }

    /**
     * Which engine the assistant would use, and a button that finds out whether it answers.
     *
     * The assistant was a switch and nothing else: no provider, no model, and no way to learn that
     * nobody is logged in except by typing a question and waiting for a failure that used to be
     * reported as a dead process. Naming the engine is also plain honesty about what leaves this
     * machine when the switch is on.
     */
    private engineRow(): Adw.ActionRow {
        let status: EngineStatus | null = null;
        try {
            status = engineStatus();
        } catch {
            // An unknown LLM_PROVIDER throws in the factory. The row still belongs here — saying
            // "not configured" is the point of it.
        }
        const row = new Adw.ActionRow({
            title: _('AI engine'),
            subtitle: markup(
                status
                    ? `${status.provider} · ${status.model}` +
                          ` · ${status.source === 'env' ? _('set via LLM_PROVIDER') : _('default')}`
                    : _('Not configured — check LLM_PROVIDER.'),
            ),
        });
        row.set_subtitle_lines(0);

        const test = new Gtk.Button({ label: _('Test connection'), valign: Gtk.Align.CENTER });
        test.set_tooltip_text(_('Asks the model a tiny question — costs a few tokens.'));
        test.connect('clicked', () => {
            test.set_sensitive(false);
            test.set_label(_('Testing …'));
            probeEngine()
                .then((result) => {
                    row.set_subtitle(markup(`${result.ok ? '✓' : '✗'} ${result.message}`));
                    if (!result.ok)
                        this.banner(fmt(_('AI engine does not respond: {message}'), { message: result.message }));
                })
                .finally(() => {
                    test.set_sensitive(true);
                    test.set_label(_('Test connection'));
                });
        });
        row.add_suffix(test);
        return row;
    }

    // ── Global settings (assistant + MCP) — built once ────────────────────────────────────────────

    private buildGlobalRows(): void {
        if (this.globalBuilt) return;
        let s: AppSettings;
        try {
            s = loadSettings();
        } catch (err) {
            this.banner(fmt(_('Settings not available: {error}'), { error: msg(err) }));
            return; // leave globalBuilt false so a later reload can retry
        }
        this.settings = s;

        this._lernmodus_group.add(
            this.switchRow(
                _('Learning mode'),
                _('Shows a “?” next to technical terms — Overview, Reports, USt-VA (VAT return) and the master data'),
                s.lernmodus,
                (on) => {
                    s.lernmodus = on;
                },
            ),
        );
        this._sync_group.add(
            this.switchRow(
                _('Sync automatically'),
                _('At start-up and then at fixed intervals, without blocking the view'),
                s.sync.enabled,
                (on) => {
                    s.sync.enabled = on;
                },
            ),
        );
        const intervals: [string, string, 'invoicesMinutes' | 'transactionsMinutes' | 'paperlessMinutes', number][] = [
            [_('Invoices (Qonto)'), _('Minutes, at least 5; 0 = off'), 'invoicesMinutes', 5],
            [_('Transactions (Qonto)'), _('Minutes, at least 15 (rate limit); 0 = off'), 'transactionsMinutes', 15],
            [_('Receipts (Paperless)'), _('Minutes, at least 5; 0 = off'), 'paperlessMinutes', 5],
        ];
        for (const [title, subtitle, key] of intervals) {
            this._sync_group.add(this.minutesRow(title, subtitle, s.sync[key], (n) => (s.sync[key] = n)));
        }
        this._assistant_group.add(
            this.switchRow(
                _('Built-in assistant'),
                _('Enable the assistant tab and /api/chat'),
                s.assistant.enabled,
                (on) => {
                    s.assistant.enabled = on;
                },
            ),
        );
        this._assistant_group.add(this.engineRow());
        this._mcp_group.add(
            this.switchRow(
                _('Provide MCP tools'),
                _('Connect external assistants (Claude, ChatGPT …)'),
                s.mcp.enabled,
                (on) => {
                    s.mcp.enabled = on;
                },
            ),
        );
        this._mcp_group.add(
            this.switchRow(
                _('Allow writing tools'),
                _('Expose mutating MCP tools (default: read-only)'),
                s.mcp.allowWrite,
                (on) => {
                    s.mcp.allowWrite = on;
                },
            ),
        );
        for (const group of MCP_GROUPS) {
            this._groups_group.add(
                this.switchRow(GROUP_LABEL[group], null, s.mcp.groups[group], (on) => {
                    s.mcp.groups[group] = on;
                }),
            );
        }
        this.globalBuilt = true;
    }

    /** A switch row whose toggle applies `set(on)` to the app settings, then persists to steuererklaerung.json. */
    private switchRow(
        title: string,
        subtitle: string | null,
        active: boolean,
        set: (on: boolean) => void,
    ): Adw.SwitchRow {
        const row = new Adw.SwitchRow({ title });
        if (subtitle) row.set_subtitle(subtitle);
        row.set_active(active); // set before connecting so this doesn't trigger a save
        row.connect('notify::active', () => {
            set(row.get_active());
            this.persistSettings();
        });
        return row;
    }

    private minutesRow(title: string, subtitle: string, value: number, set: (n: number) => void): Adw.SpinRow {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 1440, stepIncrement: 5, pageIncrement: 15, value }),
        });
        row.connect('notify::value', () => {
            set(Math.round(row.get_value()));
            this.persistSettings();
        });
        return row;
    }

    private persistSettings(): void {
        if (!this.settings) return;
        try {
            saveSettings(this.settings);
            this._save_banner.set_revealed(false);
        } catch (err) {
            this.banner(fmt(_('Could not save: {error}'), { error: msg(err) }));
        }
    }

    // ── Per-entity config groups — rebuilt on every reload ────────────────────────────────────────

    private buildEntityGroups(entity: AppEntity, year: number): void {
        this.filling = true;
        // Stamp the manifest state the widgets are about to be filled FROM, so saveWith can tell
        // whether someone else moved it since.
        this.revision = manifestRevision();
        try {
            this.clearBox(this._entity_groups);

            // A) Every entity: document management + invoicing back-ends.
            try {
                this._entity_groups.append(buildDmsGroup(this.host, entity));
                this._entity_groups.append(buildBelegeMailGroup(this.host, entity, this));
                this._entity_groups.append(buildInvoicingGroup(this.host, entity));
                if (entity.kind !== 'privat') {
                    this._entity_groups.append(buildMailGroup(this.host, entity, this));
                    this._entity_groups.append(buildMailTemplatesGroup(this.host, entity, this));
                }
            } catch (err) {
                this.banner(fmt(_('Could not read connections: {error}'), { error: msg(err) }));
            }

            // B) Business entities: Betrieb + Umsatzsteuer + Jahresabschluss-Anpassungen from the ELSTER config.
            if (entity.hasElster) {
                try {
                    const elster = loadElster(entity);
                    this._entity_groups.append(buildBetriebGroup(this.host, entity, elster));
                    this._entity_groups.append(buildUstGroup(this.host, entity, elster));
                    this._entity_groups.append(buildGewerbeGroup(this.host, entity, elster));
                    this._entity_groups.append(buildAnlagenGroup(this.host, entity, elster));
                    this._entity_groups.append(buildPrivatanteileGroup(this.host, entity, elster));
                    // The counterparty knowledge that classifies a booking with no receipt — the
                    // part of the app that stands in for the AI, and until now the one part of the
                    // config only a terminal or an agent could write.
                    this._entity_groups.append(buildKlassifizierungGroup(this.host, entity, this));
                    this._entity_groups.append(buildSonderbetriebGroup(this.host, entity, elster));
                    // Last of the business blocks: it only applies to a year the business ENDED in,
                    // so it sits below the ones every year needs rather than above them.
                    this._entity_groups.append(buildAufgabeGroup(this.host, entity, elster));
                } catch (err) {
                    this.banner(fmt(_('Could not read the ELSTER configuration: {error}'), { error: msg(err) }));
                }
            }

            // C) Privat entity: Person + the active year's Lohnsteuerbescheinigung / Vorsorge / Werbungskosten /
            //    Entlastungsbetrag (§24b).
            if (entity.hasEst) {
                try {
                    const est = loadEst(entity);
                    this._entity_groups.append(buildPersonGroup(this.host, entity, est));
                    this._entity_groups.append(buildLohnGroup(this.host, entity, est, year));
                    this._entity_groups.append(buildVorsorgeGroup(this.host, entity, est, year));
                    this._entity_groups.append(buildWerbungGroup(this.host, entity, est, year));
                    this._entity_groups.append(buildAbzuegeGroup(this.host, entity, est, year));
                    // Before §24b on purpose: that group's "Kind (Grundbetrag)" chooser reads this
                    // list, and a chooser above its own source reads as broken when both are empty.
                    this._entity_groups.append(buildKinderGroup(this.host, entity, year, this));
                    this._entity_groups.append(buildEntlastungGroup(this.host, entity, est, year));
                } catch (err) {
                    this.banner(
                        fmt(_('Could not read the ESt (income tax) configuration: {error}'), { error: msg(err) }),
                    );
                }
            }
        } finally {
            this.filling = false;
        }
    }

    // ── Shared save/banner plumbing ───────────────────────────────────────────────────────────────

    /**
     * Run a config write with the shared success/error contract: on success clear the banner, drop the
     * EÜR aggregate cache (est/elster writes only) so the tax views recompute, and toast; on any error
     * (ConfigError included) surface the message in the banner and keep running (never crash).
     */
    private saveWith(fn: () => void, opts: { clearCache?: boolean } = {}): void {
        if (this.filling) return;
        // STALENESS GUARD. These groups fill their widgets once and then write whole blocks back
        // from widget state on every edit (betrieb-ust.ts assembles all five required `betrieb`
        // keys). So a value changed meanwhile by the CLI or the resident MCP server — both write
        // the same manifest — would be silently reverted by the next unrelated edit here.
        // mutateManifest re-reading the file cannot catch that: the stale copy is in the widgets.
        const now = manifestRevision();
        if (this.revision !== null && now !== null && now !== this.revision) {
            this.banner(
                _(
                    'The configuration was changed from outside in the meantime (CLI, MCP or a second window). ' +
                        'The view is reloaded — please repeat the input.',
                ),
            );
            this.revision = now;
            if (this.entity) this.buildEntityGroups(this.entity, this.year);
            return;
        }
        try {
            fn();
            this.revision = manifestRevision(); // our own write moved it — adopt the new state
            this._save_banner.set_revealed(false);
            if (opts.clearCache && this.entity) appSession().invalidate(this.entity.id);
            showToast(_('Saved'));
        } catch (err) {
            this.banner(fmt(_('Could not save: {error}'), { error: msg(err) }));
        }
    }

    private banner(message: string): void {
        this._save_banner.set_title(markup(message)); // Banner title is Pango markup — escape it
        this._save_banner.set_revealed(true);
    }

    /** Remove every child of a Gtk.Box (PreferencesGroups added programmatically each reload). */
    private clearBox(box: Gtk.Box): void {
        let child = box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            box.remove(child);
            child = next;
        }
    }
}

function msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
