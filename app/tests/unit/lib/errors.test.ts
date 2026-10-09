import { describe, it, expect } from '@gjsify/unit';
import {
    ConfigError,
    DmsUnsupportedError,
    ManifestMissingError,
    PaperlessSetupError,
    configMissingError,
    isDmsUnsupported,
    isManifestMissing,
    isPaperlessSetupRequired,
} from '../../../src/core/lib/errors.ts';

export default async () => {
    await describe('PaperlessSetupError', async () => {
        await it('is what configMissingError throws, with the fields split out', async () => {
            let caught: unknown;
            try {
                configMissingError('custom_field_ids.qonto_transaction_id / qonto_attachment_id');
            } catch (err) {
                caught = err;
            }
            expect(isPaperlessSetupRequired(caught)).toBe(true);
            expect((caught as PaperlessSetupError).fields).toStrictEqual([
                'custom_field_ids.qonto_transaction_id',
                'qonto_attachment_id',
            ]);
        });

        await it('keeps the CLI hint in the message so terminal output is unchanged', async () => {
            const err = new PaperlessSetupError('x not set. Run "paperless setup-fields" to create and register IDs.', [
                'x',
            ]);
            expect(err.message.includes('paperless setup-fields')).toBe(true);
            expect(err.name).toBe('PaperlessSetupError');
        });

        await it('is still a ConfigError, so existing config handling keeps working', async () => {
            const err = new PaperlessSetupError('x', ['x']);
            expect(err instanceof ConfigError).toBe(true);
        });

        await it('does not claim unrelated failures — a GUI must not offer the wrong door', async () => {
            expect(isPaperlessSetupRequired(new ConfigError('no manifest'))).toBe(false);
            expect(isPaperlessSetupRequired(new Error('network down'))).toBe(false);
            expect(isPaperlessSetupRequired('paperless setup-fields')).toBe(false);
        });
    });

    await describe('DmsUnsupportedError', async () => {
        await it('names the back-end and the capability, not a Paperless misconfiguration', async () => {
            const err = new DmsUnsupportedError('USt-VA', 'builtin', 'nur aus Paperless');
            expect(isDmsUnsupported(err)).toBe(true);
            expect(err.capability).toBe('USt-VA');
            expect(err.dmsType).toBe('builtin');
        });

        await it('is not confused with the setup condition — they point at different remedies', async () => {
            const unsupported = new DmsUnsupportedError('USt-VA', 'builtin', 'x');
            const setup = new PaperlessSetupError('y', ['y']);
            expect(isPaperlessSetupRequired(unsupported)).toBe(false);
            expect(isDmsUnsupported(setup)).toBe(false);
        });
    });

    await describe('ManifestMissingError', async () => {
        await it('is the first-run condition, told apart from every other config failure', async () => {
            // Measured on a real package install: the setup assistant opened correctly, and behind
            // it the Übersicht offered `steuer config migrate` as its whole explanation. A missing
            // manifest on a fresh installation is not a fault — it is the state everyone starts in.
            const missing = new ManifestMissingError('Kein Manifest …', '/x/steuererklaerung.json');
            expect(isManifestMissing(missing)).toBe(true);
            expect(missing instanceof ConfigError).toBe(true);
            expect(missing.configPath).toBe('/x/steuererklaerung.json');
        });

        await it('does not swallow the other config conditions', async () => {
            expect(isManifestMissing(new ConfigError('kaputtes JSON'))).toBe(false);
            expect(isManifestMissing(new DmsUnsupportedError('USt-VA', 'builtin', 'x'))).toBe(false);
            expect(isManifestMissing(new Error('anything else'))).toBe(false);
        });
    });
};
