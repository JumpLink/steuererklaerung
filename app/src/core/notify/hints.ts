/**
 * The values `desktop.ts` puts into a notification, without GI so both runtimes can test them.
 *
 * **Grouping is the shell's, keyed on the desktop entry.** GNOME Shell files a notification under
 * the app whose `.desktop` file the `desktop-entry` hint names; without the hint every process gets
 * its own source. `replaces_id` cannot do this job: each reminder run is a new process and does not
 * know the id of the previous one.
 */

export type NotificationUrgency = 'low' | 'normal' | 'critical';

/** The flatpak `appId` of the app (`gjsify.flatpak` in `app/package.json`). Groups only where its desktop entry is installed. */
export const DESKTOP_ENTRY = 'eu.jumplink.Steuererklaerung';

/** The sender's display name when a caller names none. */
export const DEFAULT_APP_NAME = 'Steuererklärung';

const URGENCY_BYTE: Record<NotificationUrgency, number> = { low: 0, normal: 1, critical: 2 };

export interface NotificationHintValues {
    /** The urgency byte of the Desktop Notifications Specification. */
    urgency: number;
    desktopEntry: string;
}

export function notificationHintValues(urgency: NotificationUrgency = 'normal'): NotificationHintValues {
    return { urgency: URGENCY_BYTE[urgency], desktopEntry: DESKTOP_ENTRY };
}
