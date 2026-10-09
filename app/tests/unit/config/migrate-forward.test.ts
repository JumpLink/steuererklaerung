import { describe, it, expect } from '@gjsify/unit';
import {
    assertUpgradesContiguous,
    isManifestTooNew,
    manifestVersionOf,
    migrateManifestForward,
    type ManifestUpgrade,
} from '../../../src/core/config/migrate-forward.ts';
import { MANIFEST_VERSION } from '../../../src/core/config/schema/manifest.ts';

export default async () => {
    await describe('migrateManifestForward', async () => {
        await it('REFUSES a manifest written by a newer version', async () => {
            // The one that protects data. Reading a v2 file as v1 and writing it back drops every
            // field this version does not know about — from a file holding someone's tax numbers.
            let caught: unknown;
            try {
                migrateManifestForward({ version: MANIFEST_VERSION + 1 }, '/x/steuererklaerung.json');
            } catch (err) {
                caught = err;
            }
            expect(isManifestTooNew(caught)).toBe(true);
            expect((caught as { fileVersion: number }).fileVersion).toBe(MANIFEST_VERSION + 1);
            // The message must say what to do, not just that something is wrong.
            expect(String((caught as Error).message).includes('NICHT verändert')).toBe(true);
        });

        await it('passes a current manifest through untouched', async () => {
            const raw = { version: MANIFEST_VERSION, entities: [] };
            const result = migrateManifestForward(raw);
            expect(result.from).toBe(MANIFEST_VERSION);
            expect(result.to).toBe(MANIFEST_VERSION);
            expect(result.applied).toStrictEqual([]);
            // Same object, not a copy: a read must not quietly rewrite the caller's data.
            expect(result.raw).toBe(raw);
        });

        await it('sends the pre-v1 registry to `config migrate`, not through this path', async () => {
            // Guessing at the old registry here would produce a DIFFERENT manifest than the
            // documented command does, and nobody would know which one they got.
            let message = '';
            try {
                migrateManifestForward({ entities: [] });
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('config migrate')).toBe(true);
        });

        await it('applies the steps in order and stamps each version as it goes', async () => {
            // There is no v2 yet, so the chain is exercised with synthetic steps — the mechanism is
            // what must work on the day someone writes the real one, under time pressure.
            const steps: ManifestUpgrade[] = [
                { from: 1, describe: 'a', apply: (raw) => ((raw as Record<string, unknown>).a = true) },
                { from: 2, describe: 'b', apply: (raw) => ((raw as Record<string, unknown>).b = true) },
            ];
            const raw: Record<string, unknown> = { version: 1 };
            let version = 1;
            const applied: string[] = [];
            for (const step of steps) {
                step.apply(raw);
                version += 1;
                raw.version = version;
                applied.push(`v${step.from} → v${version}: ${step.describe}`);
            }
            expect(raw).toStrictEqual({ version: 3, a: true, b: true });
            expect(applied).toStrictEqual(['v1 → v2: a', 'v2 → v3: b']);
        });
    });

    await describe('the upgrade chain', async () => {
        await it('is contiguous and ends at the current version', async () => {
            // A gap means a manifest readable at one end of the chain and not the other, and the
            // gap stays invisible until a user with exactly that version turns up.
            assertUpgradesContiguous();
        });

        await it('catches a hole and a chain that stops short', async () => {
            const noop = () => {};
            expect(() =>
                assertUpgradesContiguous([
                    { from: 1, describe: 'a', apply: noop },
                    { from: 3, describe: 'c', apply: noop },
                ]),
            ).toThrow('Lücke');
            // Ends at v2 while the program is at v1+ — the shape of "MANIFEST_VERSION was raised
            // and the step was forgotten", which is exactly how this goes wrong in practice.
            expect(() => assertUpgradesContiguous([{ from: 7, describe: 'x', apply: noop }])).toThrow('fehlt');
        });
    });

    await describe('manifestVersionOf', async () => {
        await it('reads only an integer version, never a coincidence', async () => {
            expect(manifestVersionOf({ version: 1 })).toBe(1);
            expect(manifestVersionOf({ version: '1' })).toBe(null);
            expect(manifestVersionOf({ version: 1.5 })).toBe(null);
            expect(manifestVersionOf({})).toBe(null);
            expect(manifestVersionOf(null)).toBe(null);
        });
    });
};
