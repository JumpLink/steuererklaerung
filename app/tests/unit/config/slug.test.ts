/**
 * Turning a firm name into a legal entity id.
 *
 * `createManifestEntity` enforces `^[a-z][a-z0-9-]*$` — the id ends up in account-key globs,
 * `--entity` arguments and localStorage keys, so a space or a slash in it is a paper cut in every
 * one of those places. The setup assistant asks the user for a NAME, not an id, so the derivation
 * has to produce something legal from whatever they type without teaching them that rule.
 *
 * German firm names are the interesting input: umlauts, "ß", ampersands, and a leading legal form.
 *
 * It lives in the KERNEL, not in the assistant that first needed it. Two reasons, and the second
 * was measured: `config init` should derive the same id from `--name`, and importing a pure helper
 * out of a GTK module dragged `gi://Adw` into the test bundle — which loads fine on a developer
 * machine and dies in CI, where no libadwaita typelib exists, taking the ENTIRE suite with it.
 */
import { describe, expect, it } from '@gjsify/unit';

import { slugFromName } from '../../../src/core/config/index.ts';

/** The rule createManifestEntity actually enforces. */
const LEGAL = /^[a-z][a-z0-9-]*$/;

export default async () => {
    await describe('slugFromName', async () => {
        await it('produces a legal id for ordinary names', async () => {
            expect(slugFromName('Muster GbR')).toBe('muster-gbr');
            expect(slugFromName('JumpLink')).toBe('jumplink');
        });

        await it('spells out umlauts and ß rather than dropping them', async () => {
            // Dropping them collides: "Müller" and "Mller" are the same firm to a human, and
            // "Grosse"/"Große" would silently become one id.
            expect(slugFromName('Müller & Söhne')).toBe('mueller-soehne');
            expect(slugFromName('Große Bäckerei')).toBe('grosse-baeckerei');
        });

        await it('never emits a leading or trailing hyphen', async () => {
            expect(slugFromName('  Muster  ')).toBe('muster');
            expect(slugFromName('&Muster&')).toBe('muster');
        });

        await it('strips a leading digit, which the rule forbids', async () => {
            expect(slugFromName('1a Handwerk')).toBe('a-handwerk');
        });

        await it('falls back rather than returning something illegal', async () => {
            // A name in a non-Latin script yields nothing usable. The id is an internal handle;
            // the display name carries the identity, so a fixed fallback is fine — an empty or
            // digit-leading id would be rejected downstream.
            for (const name of ['', '   ', '株式会社', '123', '---']) {
                expect(slugFromName(name)).toBe('betrieb');
            }
        });

        await it('always satisfies the rule createManifestEntity enforces', async () => {
            const names = [
                'Muster GbR',
                'Müller & Söhne',
                'Große Bäckerei',
                '1a Handwerk',
                'Art+Code Studio',
                'O’Brien Consulting',
                'ABC   GmbH & Co. KG',
                '',
                '株式会社',
            ];
            for (const name of names) {
                expect(LEGAL.test(slugFromName(name))).toBe(true);
            }
        });
    });
};
