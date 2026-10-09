/**
 * Filing submission (the "Absenden" action) — transmit an immutable, signed-off filing snapshot to
 * ELSTER through ERiC, in a safety-laddered order.
 *
 * The design keeps the transmitted bytes BYTE-IDENTICAL to the signed snapshot: nothing is
 * re-generated or mutated here. `mode` is therefore a *checked intent*, not a transform — a snapshot
 * carrying a `<Testmerker>` can only be sent as a `test` (it is discarded at the ELSTER clearing
 * house), and a snapshot without one can only be sent `live`. Which kind a snapshot is comes from
 * `config.test_mode` at capture time, so switching from test to live means: flip test_mode → re-snapshot
 * → re-sign → live-send.
 *
 * The ladder (fail-closed, order matters):
 *   1. a snapshot must exist and not be a leftover `submitting` latch (live_pending — a prior send
 *      whose outcome is unknown; blindly retrying could double-file)
 *   2. it must not have drifted since capture (fingerprint), and the mode must match its Testmerker
 *   3. TEST is otherwise permissive — you test BEFORE you sign off, to surface problems early
 *   4. LIVE additionally requires: the full release gate (valid sign-off + clean cross-checks),
 *      a test-first `validated` snapshot, no prior `submitted` filing for the same slot
 *      (double-live block), an explicit `allowLive`, and ERiC available
 *   5. only then: latch `submitting` (live), call ERiC once (no auto-retry), record the outcome.
 *
 * The keystore PIN is passed per call and NEVER persisted (mandate). The ERiC native lib stays
 * user-provided (ERIC_HOME) and is never shipped.
 */

import { hasTestmerker, type EricSendResult } from '@steuererklaerung/eric';
import {
    assertFormType,
    getFilingSnapshot,
    isSnapshotStale,
    latestFilingSnapshot,
    listFilingSnapshots,
    markFilingSnapshotSubmitted,
    markFilingSnapshotSubmitting,
    markFilingSnapshotValidated,
    resolveEntityScope,
    type FilingFormType,
    type FilingSnapshot,
} from './snapshots.ts';
import { recordFiling } from '../filings.ts';
import { filingKindForForm, filingPeriodForScope, type FilingForm } from './filing-keys.ts';
import { evaluateSubmissionGate, type SubmissionGate } from './signoffs.ts';
import { applyEricHome, getEricStatus } from './eric-status.ts';
import {
    euerDatenartVersion,
    usteDatenartVersion,
    gewstDatenartVersion,
    feststellungDatenartVersion,
    estDatenartVersion,
} from '../../elster/index.ts';

export type SubmitMode = 'test' | 'live';

export interface SubmitFilingOptions {
    entity: string;
    year: number;
    formType: string;
    /**
     * Sub-year scope for a PERIODIC form (USt-VA), e.g. `2025-Q1`. Omit for the annual forms.
     *
     * Load-bearing: without it, submitting the USt-VA of a year picks the NEWEST snapshot of that
     * form, so a submission started for Q1 after Q2 was captured would transmit Q2's XML.
     */
    period?: string | null;
    /** `test` (Testmerker, discarded at the clearing house) or `live` (real filing). */
    mode: SubmitMode;
    /** Path to the PKCS#12 keystore (.pfx/.p12) that signs the transfer; defaults to the entity's `keystore_path`. */
    keystorePath?: string;
    /** Keystore PIN — used for this call only, never stored. */
    pin: string;
    /** Target a specific snapshot; defaults to the latest for entity/year/form. */
    snapshotId?: string;
    /** Hard opt-in required for `mode: 'live'`; ignored for test. */
    allowLive?: boolean;
    /**
     * This send BERICHTIGT an already-filed return (see
     * {@link SubmitReadinessInputs.isCorrection}). Also written into the register note, together
     * with the Transferticket it supersedes, because nothing in the transmitted data says so for
     * every form: the USt-Jahreserklärung carries an explicit marker (E3000601 „Berichtigte
     * Steuererklärung"), the ESt has NO such field — a corrected ESt is byte-wise just another
     * declaration, and the register is then the only place that records the intent.
     */
    isCorrection?: boolean;
    /** Recorded on the audit trail of a live submission. */
    submittedBy?: string;
}

/** The pre-flight verdict — everything decidable WITHOUT touching ERiC or the network. */
export interface SubmitReadiness {
    /** True ⇒ every pre-flight guard passed; the send may proceed. */
    ready: boolean;
    /** Human German reasons the send is blocked (empty ⇒ ready). */
    blockers: string[];
    /** The resolved snapshot (null when none exists for the slot). */
    snapshot: FilingSnapshot | null;
    /** Whether the snapshot's XML carries a `<Testmerker>` (⇒ a test artifact). */
    isTestArtifact: boolean;
    /** ERiC datenartVersion the send would use (e.g. `EUER_2025`), when a snapshot exists. */
    datenartVersion?: string;
}

/** The outcome of a submission attempt. */
export interface SubmitFilingResult {
    ok: boolean;
    mode: SubmitMode;
    snapshotId: string | null;
    /** ELSTER Transferticket (empty on failure / pre-flight refusal). */
    transferticket: string;
    returnCode: number | null;
    /** The snapshot status AFTER the attempt. */
    status: FilingSnapshot['status'] | null;
    /** Pre-flight blockers when the send was refused before contacting ERiC. */
    blockers: string[];
    /** Short human summary. */
    message: string;
}

/** ERiC datenartVersion for a form + year (UStVA reads its schema year from the XML namespace). */
export function datenartVersionFor(form: FilingFormType, year: number, xml: string): string {
    switch (form) {
        case 'euer':
            return euerDatenartVersion(year);
        case 'uste':
            return usteDatenartVersion(year);
        case 'gewst':
            return gewstDatenartVersion(year);
        case 'feststellung':
            return feststellungDatenartVersion(year);
        case 'est':
            return estDatenartVersion(year);
        case 'ustva': {
            // Anchored to the NAMESPACE (`…/elsteranmeldung/ustva/v2026`), which is what this
            // always meant to read. The previous pattern was `/ustva[\s\S]*?(\d{4})/i` — "ustva",
            // then the first four digits ANYWHERE after it. On the plain portal XML that happened
            // to be the namespace year; on the EDS envelope it is not, because `<DatenArt>UStVA`
            // comes first and the next digits belong to whatever follows: the Testmerker
            // (`UStVA_7000`) or the HerstellerID (`UStVA_3954`). ERiC then rejects the send with
            // "Die übergebene Datenartversion ist unbekannt", so no USt-VA could go out over ERiC.
            const ns = xml.match(/ustva\/v(\d{4})/i);
            return ns ? `UStVA_${ns[1]}` : `UStVA_${year}`;
        }
    }
}

/**
 * Does a stored snapshot belong to the period being submitted?
 *
 * The double-live guard reads "Für diesen Zeitraum", but it used to compare nothing at all — it
 * asked only whether ANY snapshot of that entity/year/form was already submitted. For a quarterly
 * form that turned a guard against filing twice into a guard against filing at all: once Q1 was
 * sent, Q2, Q3 and Q4 of the same year were permanently refused.
 *
 * `period` was added to the snapshot row later than the first web-form recordings, so an older row
 * carries `null` there and keeps its label only in `figures.period`. Both are consulted; a row that
 * names neither cannot be shown to cover a specific period, so it does not block one.
 *
 * With no period asked for (an annual form) every snapshot of that form qualifies — there is only
 * one slot per year, which is exactly what the guard should protect.
 */
export function snapshotCoversPeriod(
    snapshot: { period?: string | null; figures?: unknown },
    period: string | null | undefined,
): boolean {
    if (!period) return true;
    const fromFigures = (snapshot.figures as { period?: string } | undefined)?.period;
    return (snapshot.period ?? fromFigures) === period;
}

/**
 * The amount a filed return declares as owed, read off the snapshot that was transmitted.
 *
 * Only the two VAT forms name a payment: the USt-VA its `zahllast`, the annual USt its
 * `closingBalance` (the Abschlusszahlung after the advance payments are credited). EÜR,
 * GewSt and Feststellung establish figures — the money follows from a Bescheid, not from
 * the return — so they declare nothing here.
 *
 * Without this the ERiC path recorded a filing with `declaredAmount: null`, and
 * `list_open_tax_payments` needs an amount to report one: a return filed over ERiC simply
 * never appeared among the open payments. The web-form path passed the amount from the
 * start, so the gap only opened once ERiC became the primary route.
 */
export function declaredAmountFromSnapshot(form: FilingFormType, figures: unknown): number | undefined {
    const headline = (figures as { headline?: Record<string, unknown> } | undefined)?.headline;
    const key = form === 'ustva' ? 'zahllast' : form === 'uste' ? 'closingBalance' : undefined;
    if (!key) return undefined;
    const value = headline?.[key];
    return typeof value === 'number' ? value : undefined;
}

/** ERiC transfer-range codes (610101xxx) may have reached the server; other failures did not. */
export function mayHaveTransmitted(returnCode: number): boolean {
    return String(returnCode).startsWith('610101');
}

/**
 * Whether an EDS XML lacks a usable ELSTER Hersteller-ID — the placeholder `00000` or an empty tag.
 * ELSTER refuses to transmit such XML (surfacing as a `<DatenTeil>`-read error), so the send is
 * gated on this.
 */
export function hasPlaceholderHerstellerId(xml: string): boolean {
    return /<HerstellerID>\s*(0{5})?\s*<\/HerstellerID>/.test(xml);
}

/** Store-gathered inputs to the pure {@link computeSubmitReadiness} ladder. */
export interface SubmitReadinessInputs {
    mode: SubmitMode;
    /** The resolved snapshot, or null when none exists for the slot. */
    snapshot: FilingSnapshot | null;
    /** Whether the snapshot's XML carries a `<Testmerker>`. */
    isTestArtifact: boolean;
    /** Whether the snapshot has drifted since capture (fingerprint mismatch). */
    stale: boolean;
    /** The snapshot XML carries no valid Hersteller-ID (placeholder 00000 / empty) → ELSTER rejects the send. */
    herstellerIdMissing?: boolean;
    /** Live only: the release-gate verdict (valid sign-off + clean cross-checks). */
    gate?: SubmissionGate;
    /** Live only: a `submitted` snapshot already exists for this entity/year/form. */
    alreadyFiled?: boolean;
    /**
     * Live only: this send is a DELIBERATE correction of an already-filed return, so an existing
     * `submitted` snapshot is the expected state rather than a double-send.
     *
     * It exists because a correction is a normal — and under §153 AO sometimes MANDATORY — part of
     * filing, and without it the double-send guard made corrections impossible through the tool at
     * all. It lifts exactly that ONE blocker and nothing else: the release gate, the test-first
     * ladder and `allowLive` all still apply, and the sign-off must be for the NEW snapshot.
     */
    isCorrection?: boolean;
    /** Live only: the explicit opt-in. */
    allowLive?: boolean;
}

/**
 * The pure submission ladder — decides `ready` + `blockers` from already-gathered facts, with NO
 * I/O (unit-testable on fixtures, like {@link computeSubmissionGate}). `test` is permissive (only
 * structural guards: exists, not a leftover latch, not stale, Testmerker matches the mode); `live`
 * additionally requires the release gate to be unlocked, a validated (test-first) snapshot, no prior
 * `submitted` filing (double-live block), and an explicit `allowLive`.
 */
export function computeSubmitReadiness(inp: SubmitReadinessInputs): { ready: boolean; blockers: string[] } {
    const blockers: string[] = [];
    if (!inp.snapshot) {
        blockers.push('Kein Filing-Snapshot vorhanden — zuerst einen Snapshot erfassen.');
        return { ready: false, blockers };
    }

    // 1. Structural guards (both modes).
    if (inp.snapshot.status === 'submitting') {
        blockers.push(
            'Vorheriger Versand nicht abgeschlossen (Status „submitting") — Übertragung erst manuell abklären, kein blinder Neuversuch.',
        );
    }
    if (inp.snapshot.status === 'superseded') {
        blockers.push('Snapshot ist „superseded" (durch einen neueren ersetzt) — den aktuellen Snapshot verwenden.');
    }
    if (inp.stale) {
        blockers.push('Snapshot veraltet — die Daten haben sich seit der Erfassung geändert; neu erfassen.');
    }
    if (inp.herstellerIdMissing) {
        blockers.push(
            'Keine gültige ELSTER-Hersteller-ID (Platzhalter 00000) — 5-stellige Hersteller-ID im Entwicklerbereich von elster.de beantragen, in den Einstellungen hinterlegen und den Snapshot neu erfassen.',
        );
    }
    if (inp.mode === 'test' && !inp.isTestArtifact) {
        blockers.push(
            'Test-Versand, aber der Snapshot trägt keinen Testmerker (Echt-Artefakt). Mit test_mode=true neu erfassen.',
        );
    }
    if (inp.mode === 'live' && inp.isTestArtifact) {
        blockers.push(
            'Echt-Versand, aber der Snapshot trägt einen Testmerker (würde verworfen). Mit test_mode=false neu erfassen.',
        );
    }

    // 2. Live-only ladder: full release gate + test-first + no double-live + explicit opt-in.
    if (inp.mode === 'live') {
        if (inp.gate && !inp.gate.unlocked) blockers.push(...inp.gate.blockers);
        if (inp.snapshot.status === 'draft') {
            blockers.push(
                'Snapshot noch nicht validiert — vor dem Echt-Versand lokal validieren / testen (test-first).',
            );
        }
        if (inp.alreadyFiled && !inp.isCorrection) {
            blockers.push(
                'Für diesen Zeitraum ist bereits ein Snapshot „submitted" — doppelter Echt-Versand blockiert. ' +
                    'Wenn das eine BERICHTIGUNG sein soll: --korrektur.',
            );
        }
        // A correction claim with nothing to correct is a misunderstanding worth naming: the flag
        // would otherwise silently do nothing and the sender would believe a marker was set.
        if (inp.isCorrection && !inp.alreadyFiled) {
            blockers.push(
                'Als Berichtigung markiert, aber für diesen Zeitraum ist keine Erklärung als „submitted" erfasst — ' +
                    'ohne Erstabgabe gibt es nichts zu berichtigen. Ggf. die Erstabgabe erst im Register nachtragen.',
            );
        }
        if (inp.allowLive !== true) {
            blockers.push('Echt-Versand erfordert die ausdrückliche Bestätigung (allowLive).');
        }
    }

    return { ready: blockers.length === 0, blockers };
}

/**
 * Evaluate every pre-flight guard for a submission WITHOUT contacting ERiC or the network
 * (store-only + a fingerprint recompute) — gathers the facts and delegates to the pure
 * {@link computeSubmitReadiness}. Safe to call from a view.
 */
export function evaluateSubmitReadiness(opts: {
    entity: string;
    year: number;
    formType: string;
    /** Sub-year scope for a PERIODIC form (USt-VA), e.g. `2025-Q1`. Omit for the annual forms. */
    period?: string | null;
    mode: SubmitMode;
    snapshotId?: string;
    allowLive?: boolean;
    /** Deliberate correction of an already-filed return (see {@link SubmitReadinessInputs.isCorrection}). */
    isCorrection?: boolean;
}): SubmitReadiness {
    const form = assertFormType(opts.formType);
    const snapshot = opts.snapshotId
        ? getFilingSnapshot(opts.snapshotId)
        : latestFilingSnapshot(opts.entity, opts.year, form, opts.period);

    if (!snapshot) {
        const { blockers } = computeSubmitReadiness({
            mode: opts.mode,
            snapshot: null,
            isTestArtifact: false,
            stale: false,
        });
        return { ready: false, blockers, snapshot: null, isTestArtifact: false };
    }

    const isTestArtifact = hasTestmerker(snapshot.xml);
    const datenartVersion = datenartVersionFor(form, opts.year, snapshot.xml);
    const stale = isSnapshotStale(snapshot);
    const herstellerIdMissing = hasPlaceholderHerstellerId(snapshot.xml);
    const gate =
        opts.mode === 'live'
            ? evaluateSubmissionGate({ entity: opts.entity, year: opts.year, formType: form, period: opts.period })
            : undefined;
    const alreadyFiled =
        opts.mode === 'live' &&
        listFilingSnapshots(opts.entity, opts.year, form).some(
            (s) => s.status === 'submitted' && snapshotCoversPeriod(s, opts.period),
        );

    const { ready, blockers } = computeSubmitReadiness({
        mode: opts.mode,
        snapshot,
        isTestArtifact,
        stale,
        herstellerIdMissing,
        gate,
        alreadyFiled,
        isCorrection: opts.isCorrection,
        allowLive: opts.allowLive,
    });

    return { ready, blockers, snapshot, isTestArtifact, datenartVersion };
}

// ── Local ERiC validation (draft → validated, WITHOUT transmitting) ──────────────────────────────

/**
 * Pure pre-flight guard for a LOCAL snapshot validation: which snapshot states may be (re)validated
 * against ERiC without sending. Returns a German blocker message, or `null` when validation may
 * proceed. Terminal/latched states (`submitted`/`submitting`/`superseded`) and a drifted snapshot are
 * refused; `draft` and an already-`validated` snapshot are fine (re-validation is idempotent). Kept
 * pure (no I/O) so it is unit-testable on fixtures, like {@link computeSubmitReadiness}.
 */
export function snapshotValidationBlocker(snapshot: FilingSnapshot | null, stale: boolean): string | null {
    if (!snapshot) return 'Kein Filing-Snapshot vorhanden — zuerst einen Snapshot erfassen.';
    if (snapshot.status === 'submitted') return 'Snapshot ist bereits „submitted" — nichts zu validieren.';
    if (snapshot.status === 'submitting')
        return 'Snapshot „submitting" (Versand offen) — erst manuell abklären, nicht neu validieren.';
    if (snapshot.status === 'superseded')
        return 'Snapshot ist „superseded" (durch einen neueren ersetzt) — den aktuellen Snapshot verwenden.';
    if (stale) return 'Snapshot veraltet — die Daten haben sich seit der Erfassung geändert; neu erfassen.';
    return null;
}

/** Outcome of a local ERiC snapshot validation. */
export interface SnapshotValidationResult {
    /** True ⇒ ERiC validation passed AND the snapshot was promoted to `validated`. */
    ok: boolean;
    snapshotId: string | null;
    /** Snapshot status after the call (`validated` on success, otherwise unchanged). */
    status: FilingSnapshot['status'] | null;
    /** The ERiC verdict (false when a pre-flight blocker stopped us before the call). */
    valid: boolean;
    /** Human German summary. */
    message: string;
    /** ERiC hints on a passing validation (if any). */
    hinweise?: string | null;
    /** Pre-flight blockers when validation was refused before contacting ERiC. */
    blockers: string[];
}

/**
 * Validate a filing snapshot's FROZEN XML against the local ERiC library WITHOUT transmitting, and on
 * success promote it `draft → validated`. This is the test-first gate the live-submission ladder
 * ({@link computeSubmitReadiness}) requires for a real (non-Testmerker) artifact: a Testmerker snapshot
 * reaches `validated` via a test send, a live one via this local validation. Only the encoding
 * declaration of the frozen XML is normalised (ERiC wants UTF-8 without BOM); the bytes are otherwise
 * unchanged, so the input fingerprint a sign-off binds to is preserved.
 */
export async function validateFilingSnapshot(opts: {
    entity: string;
    year: number;
    formType: string;
    /** Sub-year scope for a PERIODIC form (USt-VA), e.g. `2025-Q1`. Omit for the annual forms. */
    period?: string | null;
    snapshotId?: string;
}): Promise<SnapshotValidationResult> {
    const form = assertFormType(opts.formType);
    const snapshot = opts.snapshotId
        ? getFilingSnapshot(opts.snapshotId)
        : latestFilingSnapshot(opts.entity, opts.year, form, opts.period);

    const stale = snapshot ? isSnapshotStale(snapshot) : false;
    const blocker = snapshotValidationBlocker(snapshot, stale);
    if (blocker || !snapshot) {
        return {
            ok: false,
            snapshotId: snapshot?.id ?? null,
            status: snapshot?.status ?? null,
            valid: false,
            message: `Validierung blockiert: ${blocker}`,
            blockers: blocker ? [blocker] : [],
        };
    }

    // Revive a non-default ERiC install (ESt has no ELSTER config → rely on the ERIC_HOME env), then
    // require ERiC to be actually loadable before validating.
    const scope = resolveEntityScope(opts.entity);
    if (scope.elster) applyEricHome(scope.elster);
    const eric = await getEricStatus(scope.elster?.eric_home);
    if (!eric.available) {
        return {
            ok: false,
            snapshotId: snapshot.id,
            status: snapshot.status,
            valid: false,
            message:
                'ERiC-Bibliothek nicht verfügbar — Systembibliothek installieren/importieren (siehe Konten-Ansicht).',
            blockers: ['ERiC-Bibliothek nicht verfügbar.'],
        };
    }

    // ERiC requires UTF-8 without BOM — normalise only the encoding declaration (bytes otherwise frozen).
    const xml = snapshot.xml.replace(/encoding="[^"]*"/, 'encoding="UTF-8"');
    const datenartVersion = datenartVersionFor(form, opts.year, snapshot.xml);
    const { validateXml, shutdownEric } = await import('@steuererklaerung/eric');
    const validation = validateXml(xml, datenartVersion);
    shutdownEric();

    if (!validation.valid) {
        return {
            ok: false,
            snapshotId: snapshot.id,
            status: snapshot.status,
            valid: false,
            message: `ERiC-Validierung fehlgeschlagen: ${validation.fehler || '(kein Fehlertext)'}`,
            blockers: [],
        };
    }

    const updated = markFilingSnapshotValidated(snapshot.id);
    return {
        ok: true,
        snapshotId: snapshot.id,
        status: updated?.status ?? 'validated',
        valid: true,
        message: 'ERiC-Validierung bestanden — Snapshot ist jetzt „validated" (test-first-Gate erfüllt).',
        hinweise: validation.hinweise || null,
        blockers: [],
    };
}

/**
 * Submit a filing snapshot to ELSTER. Runs {@link evaluateSubmitReadiness} first and refuses
 * (returning the blockers) if anything fails — nothing is transmitted. Otherwise checks ERiC
 * availability, and for a live send latches `submitting` before the single ERiC call (no auto-retry).
 * A successful test marks the snapshot `validated`; a successful live marks it `submitted` and records
 * the Transferticket + server protocol on the (immutable-otherwise) snapshot row.
 */
export async function submitFiling(opts: SubmitFilingOptions): Promise<SubmitFilingResult> {
    const readiness = evaluateSubmitReadiness(opts);
    const snapId = readiness.snapshot?.id ?? null;
    if (!readiness.ready || !readiness.snapshot) {
        return {
            ok: false,
            mode: opts.mode,
            snapshotId: snapId,
            transferticket: '',
            returnCode: null,
            status: readiness.snapshot?.status ?? null,
            blockers: readiness.blockers,
            message: `Versand blockiert: ${readiness.blockers.join(' | ')}`,
        };
    }

    const snapshot = readiness.snapshot;
    const datenartVersion = readiness.datenartVersion!;

    // Which filing does a correction replace? Read BEFORE the send: afterwards this snapshot is
    // itself `submitted` and would be indistinguishable from the one being superseded. Only the
    // ticket is kept — it is what the Finanzamt and a later reader identify the earlier
    // transmission by.
    const supersededTicket = opts.isCorrection
        ? (listFilingSnapshots(opts.entity, opts.year, assertFormType(opts.formType))
              .filter((s) => s.status === 'submitted' && s.id !== snapshot.id)
              .find((s) => s.transferTicket)?.transferTicket ?? null)
        : null;

    // Revive a non-default ERiC install, then require ERiC to be actually loadable before sending.
    const scope = resolveEntityScope(opts.entity);
    if (scope.elster) applyEricHome(scope.elster);
    const eric = await getEricStatus(scope.elster?.eric_home);
    if (!eric.available) {
        return {
            ok: false,
            mode: opts.mode,
            snapshotId: snapshot.id,
            transferticket: '',
            returnCode: null,
            status: snapshot.status,
            blockers: [
                'ERiC-Bibliothek nicht verfügbar — Systembibliothek installieren/importieren (siehe Konten-Ansicht).',
            ],
            message: 'ERiC nicht verfügbar.',
        };
    }

    // Resolve the certificate: an explicit path wins, else the entity's stored keystore_path.
    const keystorePath = opts.keystorePath?.trim() || scope.elster?.keystore_path;
    if (!keystorePath) {
        return {
            ok: false,
            mode: opts.mode,
            snapshotId: snapshot.id,
            transferticket: '',
            returnCode: null,
            status: snapshot.status,
            blockers: ['Kein Zertifikatspfad (.pfx) konfiguriert — in den Einstellungen hinterlegen oder mitgeben.'],
            message: 'Kein ELSTER-Zertifikat konfiguriert.',
        };
    }

    // ERiC requires UTF-8 without BOM — normalise only the encoding declaration (bytes otherwise frozen).
    const xml = snapshot.xml.replace(/encoding="[^"]*"/, 'encoding="UTF-8"');
    const isLive = opts.mode === 'live';

    // Live: set the live_pending latch BEFORE the call so a crash cannot be blindly retried.
    if (isLive) markFilingSnapshotSubmitting(snapshot.id);

    const { sendXml } = await import('@steuererklaerung/eric');
    /** Set when the transmission went through but the register write did not. */
    let registerNote = '';
    let result: EricSendResult;
    try {
        result = sendXml(xml, datenartVersion, {
            keystorePath,
            pin: opts.pin,
            allowLive: isLive,
        });
    } catch (err) {
        // The call threw (bad PIN, unreadable keystore, unexpected). For live, we cannot prove the
        // transmission did NOT happen → leave the `submitting` latch for manual reconciliation.
        const latest = getFilingSnapshot(snapshot.id);
        return {
            ok: false,
            mode: opts.mode,
            snapshotId: snapshot.id,
            transferticket: '',
            returnCode: null,
            status: latest?.status ?? null,
            blockers: [],
            message: `Versand fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    if (result.ok) {
        const submittedAt = new Date().toISOString().slice(0, 10);
        const updated = isLive
            ? markFilingSnapshotSubmitted(snapshot.id, {
                  transferTicket: result.transferticket || null,
                  serverProtocol: result.serverantwortXml || null,
                  source: 'eric',
                  submittedAt,
              })
            : markFilingSnapshotValidated(snapshot.id);

        // A live send also RECORDS the filing. It used to write only the snapshot,
        // and the two layers never spoke: `listSteuertermine` reads the register,
        // so a return that had gone out — with ELSTER's own receipt on the
        // snapshot — kept showing as overdue. Measured on the 2025 private ESt:
        // transmitted 28.07.2026, ticket eh2091…, and still reported 22 days late
        // on 22.08.2026. A reminder that cries wolf about something done is how a
        // real miss gets waved away later.
        //
        // The web-form path (`recordWebFiling`) has always done this; the path
        // holding the strongest evidence did not.
        if (isLive) {
            try {
                recordFiling({
                    entityId: opts.entity,
                    kind: filingKindForForm(opts.formType as FilingForm),
                    period: filingPeriodForScope(opts.formType as FilingForm, opts.year, opts.period),
                    filedAt: submittedAt,
                    declaredAmount: declaredAmountFromSnapshot(assertFormType(opts.formType), snapshot.figures),
                    note:
                        `${opts.formType.toUpperCase()} ${opts.year}${opts.isCorrection ? ' — BERICHTIGTE Erklärung' : ''} via ERiC` +
                        ` · Transferticket ${result.transferticket || '(keins)'}` +
                        `${opts.submittedBy ? ` · freigegeben von ${opts.submittedBy}` : ''}` +
                        `${opts.isCorrection && supersededTicket ? ` · ersetzt ${supersededTicket}` : ''}`,
                });
            } catch (err) {
                // The transmission SUCCEEDED — ELSTER has the return. A register
                // write that fails afterwards must not turn a filed return into a
                // failed call, so it is reported instead of thrown: the snapshot
                // already carries the receipt, and `listSteuertermine` now flags
                // the gap on its own.
                registerNote = `Achtung: die Abgabe ist durch, konnte aber nicht ins Register geschrieben werden (${err instanceof Error ? err.message : String(err)}). Bitte mit \`filing record\` nachtragen.`;
            }
        }
        // TODO(live): additionally upload the server protocol to Paperless (DMS) linked to the filing;
        // the durable record already lives on the snapshot row (transfer_ticket + server_protocol).
        return {
            ok: true,
            mode: opts.mode,
            snapshotId: snapshot.id,
            transferticket: result.transferticket,
            returnCode: result.returnCode,
            status: updated?.status ?? snapshot.status,
            blockers: [],
            message: isLive
                ? `Echt-Versand erfolgreich. Transferticket: ${result.transferticket || '(keins)'}${registerNote ? `\n${registerNote}` : ' · im Register erfasst.'}`
                : 'Test-Versand erfolgreich (verworfen am Clearing-House). Snapshot validiert.',
        };
    }

    // Failure with a return code: for live, only leave the latch if the transfer range says it MAY
    // have reached the server; a pre-transmission error (crypto/validation/IO) is safe to reset.
    let status = snapshot.status;
    if (isLive) {
        if (mayHaveTransmitted(result.returnCode)) {
            status = getFilingSnapshot(snapshot.id)?.status ?? 'submitting';
        } else {
            status = markFilingSnapshotValidated(snapshot.id)?.status ?? snapshot.status;
        }
    }
    return {
        ok: false,
        mode: opts.mode,
        snapshotId: snapshot.id,
        transferticket: '',
        returnCode: result.returnCode,
        status,
        blockers: [],
        message:
            isLive && mayHaveTransmitted(result.returnCode)
                ? `Übertragungsfehler (Status evtl. unklar, Code ${result.returnCode}) — Status „submitting" bleibt, bitte manuell prüfen.`
                : `Versand von ERiC abgelehnt (Code ${result.returnCode}): ${result.fehler.slice(0, 200)}`,
    };
}
