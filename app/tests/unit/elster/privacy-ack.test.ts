import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    acknowledgePrivacy,
    isPrivacyAcknowledged,
    logFileNoticeText,
    privacyAckPath,
    privacyNoticeText,
    readPrivacyAck,
} from '../../../src/core/actions/elster/privacy-ack.ts';
import { resolveHerstellerId } from '../../../src/core/elster/eds-envelope.ts';

// The ERiC licence (§ 5, § 15) makes the confirmation a precondition of the first send, so the
// store behind it is checked on a temp directory, including the cases that must NOT count.

export default async function () {
    describe('privacy notice confirmation', () => {
        it('starts unconfirmed and records a confirmation', () => {
            const dir = mkdtempSync(join(tmpdir(), 'privacy-ack-'));
            try {
                expect(isPrivacyAcknowledged(dir)).toBe(false);
                const ack = acknowledgePrivacy(dir, new Date('2026-10-15T08:00:00.000Z'));
                expect(ack.acknowledgedAt).toBe('2026-10-15T08:00:00.000Z');
                expect(isPrivacyAcknowledged(dir)).toBe(true);
                expect(readPrivacyAck(dir)?.version).toBe(ack.version);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('does not count a record for another notice version or a corrupt file', () => {
            const dir = mkdtempSync(join(tmpdir(), 'privacy-ack-'));
            try {
                writeFileSync(privacyAckPath(dir), JSON.stringify({ version: 0, acknowledgedAt: 'x' }));
                expect(isPrivacyAcknowledged(dir)).toBe(false);
                writeFileSync(privacyAckPath(dir), '{not json');
                expect(isPrivacyAcknowledged(dir)).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('carries the notices the licence prescribes', () => {
            expect(privacyNoticeText().includes('GDPR')).toBe(true);
            expect(logFileNoticeText().includes('{path}')).toBe(true);
        });
    });

    describe('resolveHerstellerId', () => {
        it('prefers the configured id over everything else', () => {
            expect(resolveHerstellerId('42001')).toBe('42001');
        });
        it('falls back to the placeholder when nothing is configured or bundled', () => {
            expect(resolveHerstellerId(undefined)).toBe('00000');
        });
    });
}
