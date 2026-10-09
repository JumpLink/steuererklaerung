/**
 * Identity constants for the native GNOME (GTK4 + libadwaita) front-end.
 *
 * The native app is a desktop sibling to the `steuer web` review UI: both read the same
 * backend, but this one renders with native Adwaita widgets (prep for a fully native GJS/Adwaita
 * port). The application id follows the JumpLink reverse-DNS scheme used by the other GNOME apps
 * in this ecosystem (e.g. eu.jumplink.Learn6502).
 *
 * The id carries the PRODUCT name with the umlaut transliterated (`Steuererklaerung`): it is a
 * D-Bus well-known name, the GResource path prefix and the future `.desktop`/icon basename, all
 * of which must stay ASCII. {@link APP_NAME} is the same name spelled for humans.
 */

/**
 * The GApplication id. Overridable via `STEUER_APP_ID` so a devtools/dev instance
 * (`GJSIFY_DEVTOOLS=1 STEUER_APP_ID=eu.jumplink.Steuererklaerung.Devtools …`) can run ALONGSIDE a normal
 * single-instance app instead of remote-activating it — the fix for the "can't screenshot while the
 * app is already open" blocker. Prod uses the canonical id.
 */
export const APP_ID = process.env.STEUER_APP_ID || 'eu.jumplink.Steuererklaerung';
export const APP_NAME = 'Steuererklärung';
export const APP_VERSION = '0.1.0';

/** GResource base path (derived from the app id) — used once resources are bundled. */
export const RESOURCE_PATH = `/${APP_ID.replace(/\./g, '/')}`;
