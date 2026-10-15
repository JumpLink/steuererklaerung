/**
 * ERiC is loaded through `lib*.so` only, so off Linux it must read as "not available" whatever the
 * disk holds — and the UI is told the platform is the reason, not a missing download.
 */

import { describe, expect, it } from '@gjsify/unit';
import { isEricAvailable } from '@steuererklaerung/eric';

import { ericPlatformSupported } from '../../../src/core/actions/elster/eric-status.ts';

export default async () => {
    await describe('ERiC on other platforms', async () => {
        await it('is never available on macOS or Windows', async () => {
            expect(isEricAvailable('darwin')).toBe(false);
            expect(isEricAvailable('win32')).toBe(false);
        });

        await it('reports only Linux as a supported platform', async () => {
            expect(ericPlatformSupported('linux')).toBe(true);
            expect(ericPlatformSupported('darwin')).toBe(false);
            expect(ericPlatformSupported('win32')).toBe(false);
        });
    });
};
