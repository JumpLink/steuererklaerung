/**
 * Desktop notifications over the freedesktop D-Bus interface.
 *
 * Deliberately not `notify-send`: shelling out to a binary that may not be installed turns a
 * missing dependency into a runtime surprise, and it cannot tell "no notification daemon here"
 * apart from "notification shown". This talks to `org.freedesktop.Notifications` directly and
 * REPORTS which of the two happened, so a caller that must not fail silently can decide.
 *
 * Works on any desktop with a notification daemon (GNOME, KDE, …). On a headless box there is
 * none, and {@link sendDesktopNotification} says so instead of pretending.
 */

import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

export interface DesktopNotification {
    title: string;
    body: string;
    /**
     * `critical` keeps the notification in the shell's list until it is dismissed. For a reminder
     * about money this is the right level: one that disappears after a few seconds only reminds
     * whoever happened to be looking at the screen.
     */
    urgency?: NotificationUrgency;
    /** Shown as the sender; also groups notifications in the shell. */
    appName?: string;
    /** Icon name from the current theme. */
    icon?: string;
}

export type NotificationResult =
    | { delivered: true; id: number }
    | { delivered: false; reason: 'no-session-bus' | 'no-notification-service'; detail: string };

const URGENCY_BYTE: Record<NotificationUrgency, number> = { low: 0, normal: 1, critical: 2 };

/**
 * Show a desktop notification. Never throws for the ordinary "there is no desktop here" case —
 * that is an answer, not an error, and the caller usually wants to fall back to stdout.
 */
export function sendDesktopNotification(notification: DesktopNotification): NotificationResult {
    const urgency = notification.urgency ?? 'normal';

    let bus: Gio.DBusConnection | null = null;
    try {
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    } catch (error) {
        return { delivered: false, reason: 'no-session-bus', detail: String(error) };
    }
    if (!bus) {
        return { delivered: false, reason: 'no-session-bus', detail: 'Gio.bus_get_sync returned null' };
    }

    // hints: urgency as a byte, per the Desktop Notifications Specification. The `a{sv}` slot of
    // the tuple takes the plain dictionary — wrapping it in a Variant first would nest it one
    // level too deep and the daemon would read no urgency at all.
    const hints: Record<string, GLib.Variant> = {
        urgency: GLib.Variant.new_byte(URGENCY_BYTE[urgency]),
    };

    const params = new GLib.Variant('(susssasa{sv}i)', [
        notification.appName ?? 'steuererklaerung',
        0, // replaces_id: 0 = new notification rather than replacing an earlier one
        notification.icon ?? '',
        notification.title,
        notification.body,
        [], // actions — a reminder has none; acting on it happens in a terminal
        hints,
        -1, // expire_timeout: -1 = let the daemon decide (with urgency=critical: stay)
    ]);

    try {
        const reply = bus.call_sync(
            'org.freedesktop.Notifications',
            '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications',
            'Notify',
            params,
            new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE,
            5000,
            null,
        );
        const [id] = reply.deepUnpack() as [number];
        return { delivered: true, id };
    } catch (error) {
        return { delivered: false, reason: 'no-notification-service', detail: String(error) };
    }
}
