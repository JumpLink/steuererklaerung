/**
 * `steuererklaerung.example.json` is the first file a new user opens and the file they copy to
 * `steuererklaerung.json`. Two things must therefore hold, and both have been broken before:
 *
 *   1. it must PARSE against the current `ManifestSchema` — a template that fails validation
 *      sends every newcomer straight into a Zod error dump;
 *   2. it must contain nothing real. It once carried a live USt-IdNr, a live bank's HBCI
 *      endpoint and the author's own Steuernummer prefix, because the template is edited by
 *      copying from a working config.
 *
 * (2) is asserted positively — every identifier must match a synthetic shape — so pasting a
 * real value in fails the build rather than relying on anyone noticing it.
 */

import { describe, expect, it } from '@gjsify/unit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ManifestSchema } from '../../../src/core/config/schema/manifest.ts';

const EXAMPLE_PATH = join(process.cwd(), 'steuererklaerung.example.json');
const raw = () => readFileSync(EXAMPLE_PATH, 'utf-8');

/** Every match of `re`, deduplicated, in document order. */
function findAll(text: string, re: RegExp): string[] {
    return [...new Set(text.match(re) ?? [])];
}

export default async () => {
    await describe('steuererklaerung.example.json', async () => {
        await it('is valid JSON and a schema-valid v1 manifest', async () => {
            const parsed = ManifestSchema.safeParse(JSON.parse(raw()));
            const issues = parsed.success
                ? ''
                : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
            expect(issues).toBe('');
            expect(parsed.success).toBe(true);
        });

        await it('uses only test-range IBANs', async () => {
            // 37040044 is the canonical German test bank code (the one in DE89370400440532013000).
            for (const iban of findAll(raw(), /DE\d{20}/g)) {
                expect(iban.slice(4, 12)).toBe('37040044');
            }
        });

        await it('uses only placeholder Steuernummern', async () => {
            // A real German Steuernummer never starts with the 11/222 Muster block.
            for (const nr of findAll(raw(), /\b\d{2,3}\/\d{3}\/\d{4,5}\b/g)) {
                expect(nr.startsWith('11/222/')).toBe(true);
            }
        });

        await it('uses only placeholder USt-IdNrn', async () => {
            // DE123456789 (the documentation example) and DE999999999 (obviously synthetic).
            for (const vat of findAll(raw(), /\bDE\d{9}\b/g)) {
                expect(['DE123456789', 'DE999999999'].includes(vat)).toBe(true);
            }
        });

        await it('points at no real host', async () => {
            // Any URL must sit under a reserved example/test domain (RFC 2606 / RFC 6761).
            for (const host of findAll(raw(), /https?:\/\/[^"\s]+/g)) {
                const domain = new URL(host).hostname;
                const reserved =
                    domain.endsWith('.example') || domain.endsWith('.example.com') || domain === 'localhost';
                expect(`${domain} reserved=${reserved}`).toBe(`${domain} reserved=true`);
            }
        });
    });
};
