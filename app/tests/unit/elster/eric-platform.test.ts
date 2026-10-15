/**
 * ERiC exists for Linux, Windows and macOS. Which platform a host maps to, and what "supported"
 * means for the UI, is decided here — the machine running the test must not matter.
 */

import { describe, expect, it } from '@gjsify/unit';
import { ericPlatformKnown, isEricAvailable } from '@steuererklaerung/eric';

import { ericPlatformSupported } from '../../../src/core/actions/elster/eric-status.ts';

export default async () => {
    await describe('ERiC platform support', async () => {
        await it('knows an ERiC build for Linux x64, Windows x64 and macOS', async () => {
            expect(ericPlatformKnown('linux', 'x64')).toBe(true);
            expect(ericPlatformKnown('win32', 'x64')).toBe(true);
            expect(ericPlatformKnown('darwin', 'arm64')).toBe(true);
            expect(ericPlatformKnown('darwin', 'x64')).toBe(true);
        });

        await it('knows none for architectures and systems ERiC is not built for', async () => {
            expect(ericPlatformKnown('linux', 'arm64')).toBe(false);
            expect(ericPlatformKnown('win32', 'arm64')).toBe(false);
            expect(ericPlatformKnown('freebsd', 'x64')).toBe(false);
            expect(isEricAvailable('freebsd', 'x64')).toBe(false);
        });

        await it('lets the UI tell "no build for this platform" from "not installed"', async () => {
            expect(ericPlatformSupported('linux', 'x64')).toBe(true);
            expect(ericPlatformSupported('win32', 'x64')).toBe(true);
            expect(ericPlatformSupported('darwin', 'x64')).toBe(true);
            expect(ericPlatformSupported('freebsd', 'x64')).toBe(false);
        });
    });
};
