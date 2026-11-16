/**
 * Where the phone keeps its Paperless connection: the address in app-settings (not secret),
 * the token in the Keystore-backed store of secrets.ts. Nothing comes from an environment.
 */
import { Settings } from '@gjsify/app-settings/nativescript';
import type { PaperlessCreds } from './paperless.ts';
import { deleteSecret, getSecret, setSecret } from './secrets.ts';

const SCHEMA_ID = 'eu.jumplink.Steuererklaerung';
const SCHEMA_PATH = '/eu/jumplink/Steuererklaerung/';
const URL_KEY = 'paperless-url';
const TOKEN_SECRET = 'paperless-token';

Settings.register({
    id: SCHEMA_ID,
    path: SCHEMA_PATH,
    keys: { [URL_KEY]: { type: 's', default: '' } },
});
const settings = new Settings({ schema_id: SCHEMA_ID, path: SCHEMA_PATH });

export function savedPaperlessUrl(): string {
    return settings.get_string(URL_KEY);
}

/** The stored connection, or null while either half is missing. */
export function loadPaperlessCreds(): PaperlessCreds | null {
    const url = savedPaperlessUrl();
    const token = getSecret(TOKEN_SECRET);
    return url && token ? { url, token } : null;
}

export function savePaperlessCreds(creds: PaperlessCreds): void {
    settings.set_string(URL_KEY, creds.url);
    setSecret(TOKEN_SECRET, creds.token);
}

export function clearPaperlessCreds(): void {
    settings.set_string(URL_KEY, '');
    deleteSecret(TOKEN_SECRET);
}
