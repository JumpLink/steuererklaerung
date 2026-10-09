import { describe, it, expect } from '@gjsify/unit';
import {
    computeSubmitReadiness,
    datenartVersionFor,
    snapshotCoversPeriod,
    declaredAmountFromSnapshot,
    mayHaveTransmitted,
    hasPlaceholderHerstellerId,
    snapshotValidationBlocker,
    type SubmitReadinessInputs,
} from '../../../src/core/actions/elster/submit.ts';
import { snapshotFormsFromPlan } from '../../../src/core/actions/elster/submission-overview.ts';
import type { FilingSnapshot, FilingSnapshotStatus } from '@steuererklaerung/store';
import type { SubmissionGate } from '../../../src/core/actions/elster/signoffs.ts';

// The submission ladder is safety-critical (it can transmit to a government server), so its pure
// decision core is exercised directly on fixtures — no store, no ERiC.

function snap(status: FilingSnapshotStatus, xml: string): FilingSnapshot {
    return {
        id: 's1',
        entityId: 'gbr',
        year: 2025,
        formType: 'euer',

        period: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        fingerprint: 'v1:abc',
        xml,
        figures: {},
        status,
        transferTicket: null,
        serverProtocol: null,
        submissionSource: null,
        submittedAt: null,
        note: null,
    };
}
const TEST_XML = '<Elster><Testmerker>700000004</Testmerker><Nutzdaten/></Elster>';
const LIVE_XML = '<Elster><Nutzdaten/></Elster>';
const OPEN_GATE: SubmissionGate = { unlocked: true, blockers: [] };
const CLOSED_GATE: SubmissionGate = { unlocked: false, blockers: ['Keine Freigabe (sign-off) vorhanden.'] };

function base(over: Partial<SubmitReadinessInputs>): SubmitReadinessInputs {
    return { mode: 'test', snapshot: snap('validated', TEST_XML), isTestArtifact: true, stale: false, ...over };
}

export default async function () {
    describe('computeSubmitReadiness — structural guards (both modes)', () => {
        it('blocks when no snapshot exists', () => {
            const r = computeSubmitReadiness(base({ snapshot: null }));
            expect(r.ready).toBe(false);
            expect(r.blockers[0]).toContain('Kein Filing-Snapshot');
        });
        it('blocks a leftover submitting latch (no blind retry)', () => {
            const r = computeSubmitReadiness(base({ snapshot: snap('submitting', TEST_XML) }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('submitting');
        });
        it('blocks a stale snapshot', () => {
            const r = computeSubmitReadiness(base({ stale: true }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('veraltet');
        });
        it('blocks a superseded snapshot', () => {
            const r = computeSubmitReadiness(base({ snapshot: snap('superseded', TEST_XML) }));
            expect(r.ready).toBe(false);
        });
    });

    describe('computeSubmitReadiness — test mode (permissive)', () => {
        it('is ready for a validated test artifact', () => {
            const r = computeSubmitReadiness(base({}));
            expect(r.ready).toBe(true);
            expect(r.blockers.length).toBe(0);
        });
        it('does NOT require a sign-off for a test send (test-first)', () => {
            // No gate passed at all → still ready in test mode.
            const r = computeSubmitReadiness(base({ snapshot: snap('draft', TEST_XML) }));
            expect(r.ready).toBe(true);
        });
        it('refuses a test send of a LIVE artifact (no Testmerker)', () => {
            const r = computeSubmitReadiness(base({ isTestArtifact: false, snapshot: snap('validated', LIVE_XML) }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('keinen Testmerker');
        });
        it('blocks when the snapshot has no valid Hersteller-ID (both modes)', () => {
            const r = computeSubmitReadiness(base({ herstellerIdMissing: true }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('Hersteller-ID');
        });
    });

    describe('hasPlaceholderHerstellerId', () => {
        it('is true for the 00000 placeholder or an empty tag', () => {
            expect(hasPlaceholderHerstellerId('<a><HerstellerID>00000</HerstellerID></a>')).toBe(true);
            expect(hasPlaceholderHerstellerId('<a><HerstellerID></HerstellerID></a>')).toBe(true);
        });
        it('is false for a real 5-digit Hersteller-ID', () => {
            expect(hasPlaceholderHerstellerId('<a><HerstellerID>12345</HerstellerID></a>')).toBe(false);
        });
    });

    describe('computeSubmitReadiness — live mode (full gate)', () => {
        function live(over: Partial<SubmitReadinessInputs>): SubmitReadinessInputs {
            return base({
                mode: 'live',
                isTestArtifact: false,
                snapshot: snap('validated', LIVE_XML),
                gate: OPEN_GATE,
                alreadyFiled: false,
                allowLive: true,
                ...over,
            });
        }

        it('is ready when gate open, validated, not filed, allowLive', () => {
            expect(computeSubmitReadiness(live({})).ready).toBe(true);
        });
        it('refuses a live send of a TEST artifact (would be discarded)', () => {
            const r = computeSubmitReadiness(live({ isTestArtifact: true, snapshot: snap('validated', TEST_XML) }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('würde verworfen');
        });
        it('propagates the closed release gate blockers', () => {
            const r = computeSubmitReadiness(live({ gate: CLOSED_GATE }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('Freigabe');
        });
        it('blocks a live send of a draft (test-first)', () => {
            const r = computeSubmitReadiness(live({ snapshot: snap('draft', LIVE_XML) }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('test-first');
        });
        it('blocks a double live send (already submitted)', () => {
            const r = computeSubmitReadiness(live({ alreadyFiled: true }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('doppelter');
        });
        it('requires the explicit allowLive opt-in', () => {
            const r = computeSubmitReadiness(live({ allowLive: false }));
            expect(r.ready).toBe(false);
            expect(r.blockers.join(' ')).toContain('allowLive');
        });

        /**
         * A correction is a normal part of filing — under §153 AO sometimes mandatory. The
         * double-send guard made it impossible through the tool at all: the live ESt 2025 went out
         * on 28.07.2026, a 27,08 € error was found, and the corrected return could not be sent
         * because a `submitted` snapshot existed. `--korrektur` states the intent instead.
         */
        describe('deliberate correction of an already-filed return', () => {
            it('lets a correction through the double-send guard', () => {
                const r = computeSubmitReadiness(live({ alreadyFiled: true, isCorrection: true }));
                expect(r.ready).toBe(true);
            });
            it('names the flag in the blocker, so the way out is discoverable', () => {
                const r = computeSubmitReadiness(live({ alreadyFiled: true }));
                expect(r.blockers.join(' ')).toContain('--korrektur');
            });
            it('lifts ONLY that blocker — every other guard still holds', () => {
                // The discriminator: a correction must not become a way past the release gate,
                // the test-first ladder or the live opt-in.
                const gate = computeSubmitReadiness(
                    live({ alreadyFiled: true, isCorrection: true, gate: CLOSED_GATE }),
                );
                expect(gate.ready).toBe(false);
                const draft = computeSubmitReadiness(
                    live({ alreadyFiled: true, isCorrection: true, snapshot: snap('draft', LIVE_XML) }),
                );
                expect(draft.ready).toBe(false);
                const optIn = computeSubmitReadiness(
                    live({ alreadyFiled: true, isCorrection: true, allowLive: false }),
                );
                expect(optIn.ready).toBe(false);
                const testArtifact = computeSubmitReadiness(
                    live({
                        alreadyFiled: true,
                        isCorrection: true,
                        isTestArtifact: true,
                        snapshot: snap('validated', TEST_XML),
                    }),
                );
                expect(testArtifact.ready).toBe(false);
            });
            it('refuses a correction when there is nothing to correct', () => {
                // Otherwise the flag silently does nothing and the sender believes it was honoured.
                const r = computeSubmitReadiness(live({ alreadyFiled: false, isCorrection: true }));
                expect(r.ready).toBe(false);
                expect(r.blockers.join(' ')).toContain('nichts zu berichtigen');
            });
        });
    });

    describe('datenartVersionFor', () => {
        it('maps the annual forms to their ERiC token', () => {
            expect(datenartVersionFor('euer', 2025, '')).toBe('EUER_2025');
            expect(datenartVersionFor('uste', 2025, '')).toBe('USt_2025');
            expect(datenartVersionFor('gewst', 2025, '')).toBe('GewSt_2025');
            expect(datenartVersionFor('feststellung', 2025, '')).toBe('FEIN_90_2025');
            expect(datenartVersionFor('est', 2025, '')).toBe('ESt_2025');
        });
        it('falls back to the year for UStVA', () => {
            expect(datenartVersionFor('ustva', 2025, '<no-ns/>')).toBe('UStVA_2025');
        });
        it('reads the UStVA year from the namespace, not from stray digits', () => {
            // The namespace is the source of truth — it may disagree with the `year` argument.
            const plain = '<Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v2026">';
            expect(datenartVersionFor('ustva', 2025, plain)).toBe('UStVA_2026');
        });
        it('is not fooled by digits that precede the namespace in the EDS envelope', () => {
            // The regression: the old pattern took "ustva" from <DatenArt> and then the first four
            // digits ANYWHERE after it — the Testmerker or the HerstellerID, never the year. ERiC
            // answered "Die übergebene Datenartversion ist unbekannt" and no USt-VA could be sent.
            const eds =
                '<Elster><TransferHeader><DatenArt>UStVA</DatenArt>' +
                '<Testmerker>700000004</Testmerker><HerstellerID>39542</HerstellerID>' +
                '</TransferHeader><DatenTeil>' +
                '<Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v2026">' +
                '</Anmeldungssteuern></DatenTeil></Elster>';
            expect(datenartVersionFor('ustva', 2026, eds)).toBe('UStVA_2026');
            // Spell the two wrong answers out, so a future rewrite cannot quietly reintroduce them.
            expect(datenartVersionFor('ustva', 2026, eds)).not.toBe('UStVA_7000');
            expect(datenartVersionFor('ustva', 2026, eds)).not.toBe('UStVA_3954');
        });
    });

    describe('declaredAmountFromSnapshot — was eine Abgabe als faellig anmeldet', () => {
        it('reads the USt-VA Zahllast', () => {
            expect(declaredAmountFromSnapshot('ustva', { headline: { zahllast: 186.4 } })).toBe(186.4);
        });

        it('reads the annual USt Abschlusszahlung, not its Zahllast', () => {
            // vatPayable is the year's tax; closingBalance is what is left to pay after the
            // advance payments — only the latter is a payment obligation.
            const figures = { headline: { vatPayable: 1531.73, closingBalance: 1091.16 } };
            expect(declaredAmountFromSnapshot('uste', figures)).toBe(1091.16);
        });

        it('declares nothing for the forms whose money follows from a Bescheid', () => {
            // EÜR/GewSt/Feststellung establish figures; the payment comes later and elsewhere.
            expect(declaredAmountFromSnapshot('euer', { headline: { profit: 2533.74 } })).toBe(undefined);
            expect(declaredAmountFromSnapshot('gewst', { headline: { messbetrag: 0 } })).toBe(undefined);
            expect(declaredAmountFromSnapshot('feststellung', { headline: { totalProfit: 1 } })).toBe(undefined);
        });

        it('survives a snapshot with no figures at all', () => {
            expect(declaredAmountFromSnapshot('ustva', undefined)).toBe(undefined);
            expect(declaredAmountFromSnapshot('ustva', {})).toBe(undefined);
            // A non-numeric value is not an amount — recording it would poison the register.
            expect(declaredAmountFromSnapshot('ustva', { headline: { zahllast: '186,40' } })).toBe(undefined);
        });
    });

    describe('snapshotCoversPeriod — der Doppelversand-Schutz', () => {
        it('blocks only the SAME quarter, never the whole year', () => {
            // The regression: the guard asked whether ANY snapshot of the year was submitted, so a
            // filed Q1 permanently refused Q2, Q3 and Q4 — "nie wieder senden" statt "nicht zweimal".
            expect(snapshotCoversPeriod({ period: '2026-Q1' }, '2026-Q2')).toBe(false);
            expect(snapshotCoversPeriod({ period: '2026-Q2' }, '2026-Q2')).toBe(true);
        });

        it('falls back to figures.period for rows written before the column existed', () => {
            // The two web-form Q1 recordings carry period:null and keep their label in figures.
            const legacy = { period: null, figures: { period: '2026-Q1' } };
            expect(snapshotCoversPeriod(legacy, '2026-Q1')).toBe(true);
            expect(snapshotCoversPeriod(legacy, '2026-Q2')).toBe(false);
        });

        it('cannot be shown to cover a period when it names none', () => {
            expect(snapshotCoversPeriod({ period: null }, '2026-Q2')).toBe(false);
        });

        it('matches everything for an annual form, which has one slot per year', () => {
            expect(snapshotCoversPeriod({ period: null }, undefined)).toBe(true);
            expect(snapshotCoversPeriod({ period: '2026-Q1' }, undefined)).toBe(true);
        });
    });

    describe('snapshotFormsFromPlan', () => {
        it('keeps snapshot-able forms in filing order, incl. est (nach den Business-Formularen)', () => {
            expect(snapshotFormsFromPlan(['euer', 'uste', 'est']).join(',')).toBe('euer,uste,est');
            expect(snapshotFormsFromPlan(['euer', 'feststellung', 'gewst', 'uste']).join(',')).toBe(
                'feststellung,euer,uste,gewst',
            );
        });
        it('includes est for an est-only (privat) plan (est ist jetzt snapshot-fähig)', () => {
            expect(snapshotFormsFromPlan(['est']).join(',')).toBe('est');
        });
    });

    describe('mayHaveTransmitted — no-blind-retry classification', () => {
        it('is true for transfer-range codes (610101xxx)', () => {
            expect(mayHaveTransmitted(610101200)).toBe(true);
            expect(mayHaveTransmitted(610101283)).toBe(true);
        });
        it('is false for crypto/validation/IO codes', () => {
            expect(mayHaveTransmitted(610201106)).toBe(false); // PIN wrong
            expect(mayHaveTransmitted(610001002)).toBe(false); // Prüf-Fehler
        });
    });

    describe('snapshotValidationBlocker — local ERiC validation pre-flight', () => {
        it('blocks when no snapshot exists', () => {
            expect(snapshotValidationBlocker(null, false)).toContain('Kein Filing-Snapshot');
        });
        it('allows a fresh draft (the draft → validated case the live ladder needs)', () => {
            expect(snapshotValidationBlocker(snap('draft', LIVE_XML), false)).toBe(null);
        });
        it('allows re-validating an already-validated snapshot (idempotent)', () => {
            expect(snapshotValidationBlocker(snap('validated', LIVE_XML), false)).toBe(null);
        });
        it('blocks a stale snapshot (re-capture first)', () => {
            expect(snapshotValidationBlocker(snap('draft', LIVE_XML), true)).toContain('veraltet');
        });
        it('refuses an already-submitted snapshot', () => {
            expect(snapshotValidationBlocker(snap('submitted', LIVE_XML), false)).toContain('submitted');
        });
        it('refuses a submitting latch (send in flight)', () => {
            expect(snapshotValidationBlocker(snap('submitting', LIVE_XML), false)).toContain('submitting');
        });
        it('refuses a superseded snapshot', () => {
            expect(snapshotValidationBlocker(snap('superseded', LIVE_XML), false)).toContain('superseded');
        });
    });
}
