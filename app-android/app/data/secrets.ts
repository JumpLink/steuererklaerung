/**
 * Token store: AES-GCM key in the Android Keystore, ciphertext in SharedPreferences.
 * Gap: the gjsify secret-service / system-accounts bridge does not exist for NativeScript,
 * so this talks to the Java APIs directly. Device-only; no unit test (see docs below).
 */
import { Utils } from '@nativescript/core';

declare const java: any;
declare const javax: any;
declare const android: any;

const ALIAS = 'steuer_secrets_key';
const PREFS = 'steuer_secrets';
const ENCRYPT = 1, DECRYPT = 2, NO_WRAP = 2;

function key(): any {
    const ks = java.security.KeyStore.getInstance('AndroidKeyStore');
    ks.load(null);
    if (!ks.containsAlias(ALIAS)) {
        const gen = javax.crypto.KeyGenerator.getInstance('AES', 'AndroidKeyStore');
        gen.init(
            new android.security.keystore.KeyGenParameterSpec.Builder(ALIAS, 3)
                .setBlockModes(['GCM'])
                .setEncryptionPaddings(['NoPadding'])
                .setKeySize(256)
                .build(),
        );
        gen.generateKey();
    }
    return ks.getKey(ALIAS, null);
}

const prefs = () => Utils.android.getApplicationContext().getSharedPreferences(PREFS, 0);
const b64 = (b: any) => android.util.Base64.encodeToString(b, NO_WRAP);
const unb64 = (s: string) => android.util.Base64.decode(s, NO_WRAP);

export function setSecret(name: string, value: string): void {
    const c = javax.crypto.Cipher.getInstance('AES/GCM/NoPadding');
    c.init(ENCRYPT, key());
    const ct = c.doFinal(new java.lang.String(value).getBytes('UTF-8'));
    prefs().edit().putString(name, `${b64(c.getIV())}:${b64(ct)}`).apply();
}

export function getSecret(name: string): string | null {
    const raw = prefs().getString(name, null);
    if (!raw) return null;
    const [iv, ct] = raw.split(':');
    const c = javax.crypto.Cipher.getInstance('AES/GCM/NoPadding');
    c.init(DECRYPT, key(), new javax.crypto.spec.GCMParameterSpec(128, unb64(iv)));
    return String(new java.lang.String(c.doFinal(unb64(ct)), 'UTF-8'));
}

export function deleteSecret(name: string): void {
    prefs().edit().remove(name).apply();
}
