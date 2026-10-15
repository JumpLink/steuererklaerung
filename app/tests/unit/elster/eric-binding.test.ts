/**
 * The native SteuerEric binding on GJS: when its typelib is reachable, `Eric` must carry a real
 * GType. A prebuild whose libsteuereric.so still links a vanished library lists the class but has
 * no GType, which GJS reports as "Unsupported type void" (issue #85).
 */

import { describe, expect, it } from '@gjsify/unit';
import { EricBindingError, EricNotAvailableError } from '../../../../packages/eric/src/errors.ts';

type GiShape = { gi?: Record<string, { Eric?: { $gtype: unknown } }> };

export default async () => {
    await describe('EricBindingError', async () => {
        await it('is an EricNotAvailableError that keeps the raw cause', async () => {
            const err = new EricBindingError('Unsupported type void');
            expect(err instanceof EricNotAvailableError).toBe(true);
            expect(err.cause).toBe('Unsupported type void');
            expect(err.message.includes('build:meson')).toBe(true);
        });
    });

    await describe('SteuerEric GJS binding', async () => {
        await it('has a valid GType when the typelib is built', async () => {
            const gi = (globalThis as unknown as { imports?: GiShape }).imports?.gi;
            let eric: { $gtype: unknown } | undefined;
            try {
                eric = gi?.SteuerEric?.Eric;
            } catch {
                return; // binding not built in this checkout / on this runtime
            }
            if (!eric) return;
            expect(String(eric.$gtype).includes('SteuerEricEric')).toBe(true);
        });
    });
};
