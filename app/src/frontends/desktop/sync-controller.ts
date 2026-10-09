/**
 * Glue between the core sync service and the window: owns the one service, the periodic tick and the
 * headerbar button's look. Automatic runs start at launch and then once a minute check what is due;
 * the intervals themselves live in the settings.
 */

import Gtk from '@girs/gtk-4.0';
import GLib from '@girs/glib-2.0';

import { isDemoMode } from '../../core/config/demo.ts';
import { loadAppSettings } from '../../core/config/index.ts';
import { createDemoRunners } from '../../core/sync/demo-runners.ts';
import { DEFAULT_SYNC_SCHEDULE, affectsView, SYNC_SOURCE_LABEL, type SyncSchedule } from '../../core/sync/plan.ts';
import { syncEntityInfo } from '../../core/sync/entity-info.ts';
import { createRunners, defaultRunnerDeps } from '../../core/sync/runners.ts';
import { createSyncService, type SyncRunResult } from '../../core/sync/service.ts';
import { appSession } from './data/session.ts';
import { clearYearCache } from './data/assistent.ts';
import type { AppEntity } from './entities.ts';
import { showToast } from './toast.ts';

const TICK_SECONDS = 60;

function schedule(): SyncSchedule {
    try {
        return loadAppSettings().sync;
    } catch {
        return DEFAULT_SYNC_SCHEDULE;
    }
}

export function relativeTime(then: number, now = Date.now()): string {
    const mins = Math.max(0, Math.round((now - then) / 60_000));
    if (mins < 1) return 'gerade eben';
    if (mins < 60) return `vor ${mins} Min.`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `vor ${hours} Std.` : `vor ${Math.round(hours / 24)} Tg.`;
}

export interface SyncHost {
    entity(): AppEntity | null;
    entityById(id: string): AppEntity | null;
    view(): string | undefined;
    /** Reload the open view after a run changed what it shows. */
    reloadView(): void;
}

export class SyncController {
    private readonly service;
    private tickSource = 0;

    constructor(
        private readonly button: Gtk.Button,
        private readonly host: SyncHost,
    ) {
        this.service = createSyncService({
            runners: isDemoMode()
                ? createDemoRunners()
                : createRunners({
                      ...defaultRunnerDeps,
                      listDocumentIds: async (entityId) => {
                          const entity = this.host.entityById(entityId);
                          if (!entity) return [];
                          const year = new Date().getFullYear();
                          appSession().invalidate(entity.id, year); // the session memoizes; a sync must really ask
                          const { docs } = await appSession().documents(entity, year);
                          return docs.map((d) => d.id);
                      },
                  }),
            schedule,
            now: () => Date.now(),
        });
        this.service.subscribe(() => this.refresh());
        this.button.connect('clicked', () => void this.manual());
        this.refresh();
        this.tickSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            void this.auto();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            void this.auto();
            return GLib.SOURCE_REMOVE;
        });
    }

    private request() {
        const entity = this.host.entity();
        if (!entity) return null;
        let info;
        try {
            info = syncEntityInfo(entity.id, appSession().dms(entity).kind);
        } catch {
            return null;
        }
        return { entity: info, view: this.host.view() };
    }

    private async manual(): Promise<void> {
        const req = this.request();
        if (!req) return;
        this.finish(await this.service.run({ ...req, trigger: 'manual' }), true);
    }

    private async auto(): Promise<void> {
        const req = this.request();
        if (!req) return;
        const result = await this.service.tick(req);
        if (result) this.finish(result, false);
    }

    private finish(result: SyncRunResult, manual: boolean): void {
        if (result.changed.length > 0) {
            appSession().invalidate(); // new bookings/documents/invoices → memoized aggregates are stale
            clearYearCache();
        }
        if (affectsView(this.host.view(), result.changed)) this.host.reloadView();
        if (result.failures.length > 0) {
            if (manual)
                showToast(
                    `Abgleich: ${result.failures.map((f) => `${SYNC_SOURCE_LABEL[f.source]} — ${f.message}`).join(' · ')}`,
                    5,
                );
        } else if (manual) {
            showToast(result.ran.length === 0 ? 'Nichts abzugleichen' : 'Abgleich abgeschlossen');
        }
    }

    /** Stop the periodic tick; called when the window closes. */
    dispose(): void {
        if (this.tickSource) GLib.Source.remove(this.tickSource);
        this.tickSource = 0;
    }

    /** Redraw the button for the entity now selected (also after an entity switch). */
    refresh(): void {
        const s = this.service.status(this.host.entity()?.id);
        if (s.running) {
            const spinner = new Gtk.Spinner({ spinning: true });
            this.button.set_child(spinner);
            this.button.set_sensitive(false);
            this.button.set_tooltip_text(`Gleicht ab: ${s.current ? SYNC_SOURCE_LABEL[s.current] : ''} …`);
            return;
        }
        this.button.set_child(
            new Gtk.Image({ iconName: s.lastError ? 'dialog-warning-symbolic' : 'view-refresh-symbolic' }),
        );
        this.button.set_sensitive(true);
        const last = s.lastSuccessAt ? `Letzter Abgleich ${relativeTime(s.lastSuccessAt)}` : 'Noch nicht abgeglichen';
        const err = s.lastError ? `\nFehler: ${SYNC_SOURCE_LABEL[s.lastError.source]} — ${s.lastError.message}` : '';
        this.button.set_tooltip_text(`${last}${err}`);
    }
}
