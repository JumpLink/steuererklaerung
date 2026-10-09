import { describe, it, expect } from '@gjsify/unit';
import {
    hasTestmerker,
    assertSendAllowed,
    parseTransferticket,
    mapSendResult,
    EricError,
    EricErrorCodes,
    type SendXmlOptions,
} from '@steuererklaerung/eric';

// The SEND path can transmit to a government server, so its runtime-agnostic
// guard + parsing helpers carry the safety weight. These run without ERiC.

const TEST_XML = '<Elster><TransferHeader><Testmerker>700000004</Testmerker></TransferHeader></Elster>';
const LIVE_XML = '<Elster><TransferHeader><Verfahren>ElsterAnmeldung</Verfahren></TransferHeader></Elster>';
const CERT: SendXmlOptions = { keystorePath: '/tmp/test.pfx', pin: '123456' };

export default async function () {
    describe('hasTestmerker', () => {
        it('detects a Testmerker element', () => {
            expect(hasTestmerker(TEST_XML)).toBe(true);
        });
        it('is false when no Testmerker is present', () => {
            expect(hasTestmerker(LIVE_XML)).toBe(false);
        });
    });

    describe('assertSendAllowed — the live-send guard', () => {
        it('refuses a live XML (no Testmerker) without allowLive', () => {
            let threw: unknown;
            try {
                assertSendAllowed(LIVE_XML, CERT);
            } catch (e) {
                threw = e;
            }
            expect(threw instanceof EricError).toBe(true);
            expect((threw as Error).message).toContain('LIVE');
        });

        it('allows a test XML (Testmerker present) to proceed', () => {
            let threw: unknown;
            try {
                assertSendAllowed(TEST_XML, CERT);
            } catch (e) {
                threw = e;
            }
            expect(threw).toBe(undefined);
        });

        it('allows a live XML only when allowLive is explicitly true', () => {
            let threw: unknown;
            try {
                assertSendAllowed(LIVE_XML, { ...CERT, allowLive: true });
            } catch (e) {
                threw = e;
            }
            expect(threw).toBe(undefined);
        });

        it('requires a keystore path', () => {
            let threw: unknown;
            try {
                assertSendAllowed(TEST_XML, { keystorePath: '', pin: '123456' });
            } catch (e) {
                threw = e;
            }
            expect(threw instanceof EricError).toBe(true);
        });
    });

    describe('parseTransferticket', () => {
        it('extracts the Transferticket from a server answer', () => {
            const sa = '<Antwort><TransferTicket>abc-123-XYZ</TransferTicket></Antwort>';
            expect(parseTransferticket(sa)).toBe('abc-123-XYZ');
        });
        it('returns empty when no Transferticket is present', () => {
            expect(parseTransferticket('<Antwort/>')).toBe('');
        });
    });

    describe('mapSendResult', () => {
        it('maps ERIC_OK to an accepted result and keeps the ticket', () => {
            const sa = '<Antwort><TransferTicket>T-1</TransferTicket></Antwort>';
            const r = mapSendResult(EricErrorCodes.ERIC_OK, '<recv/>', sa, TEST_XML);
            expect(r.ok).toBe(true);
            expect(r.testMode).toBe(true);
            expect(r.transferticket).toBe('T-1');
            expect(r.fehler).toBe('');
        });

        it('maps a Prüf-Fehler to a failure and drops the ticket', () => {
            const sa = '<Antwort><TransferTicket>T-2</TransferTicket></Antwort>';
            const r = mapSendResult(EricErrorCodes.ERIC_GLOBAL_PRUEF_FEHLER, '<err>bad</err>', sa, LIVE_XML);
            expect(r.ok).toBe(false);
            expect(r.transferticket).toBe('');
            expect(r.fehler).toBe('<err>bad</err>');
            expect(r.testMode).toBe(false);
        });

        it('treats ERIC_GLOBAL_HINWEISE as accepted-with-hints', () => {
            const r = mapSendResult(EricErrorCodes.ERIC_GLOBAL_HINWEISE, '<hint/>', '<a/>', TEST_XML);
            expect(r.ok).toBe(true);
            expect(r.hinweise).toBe('<hint/>');
        });
    });
}
