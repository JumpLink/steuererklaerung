/**
 * Unit tests for the KI-Hinweis (ai_note) rationale recorded by review-metadata:
 * the rationale text, its overwrite-into-payload semantics, and the dry-run gate.
 * Pure helpers only — no Paperless, no live enrichment (the updater is injected).
 */

import { describe, it, expect } from '@gjsify/unit';
import {
    buildAiNoteRationale,
    applyAiNoteToPayload,
    commitDocumentUpdate,
} from '../../../src/core/actions/paperless/review-metadata.ts';

// A silent logger so commitDocumentUpdate's log.info in dry-run doesn't spam output.
const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
} as unknown as Parameters<typeof commitDocumentUpdate>[3];

export default async () => {
    await describe('review-metadata ai_note (KI-Hinweis)', async () => {
        await describe('buildAiNoteRationale', async () => {
            await it('produces a concise German rationale with what changed + provenance', async () => {
                const note = buildAiNoteRationale({
                    date: '2026-07-09',
                    model: 'claude-opus-4-8',
                    correspondentName: 'ACME GmbH',
                    documentTypeName: 'Eingangsrechnung',
                    typeEnrichmentApplied: true,
                });
                expect(note).toContain('KI-Review 2026-07-09');
                expect(note).toContain('Korrespondent «ACME GmbH»');
                expect(note).toContain('Typ «Eingangsrechnung»');
                expect(note).toContain('Rechnungsdaten erkannt');
                expect(note).toContain('Modell «claude-opus-4-8»');
                expect(note.length).toBeLessThan(200);
            });

            await it('falls back to "Metadaten geprüft" when nothing specific resolved', async () => {
                const note = buildAiNoteRationale({ date: '2026-07-09', model: 'claude-x' });
                expect(note).toContain('Metadaten geprüft');
                expect(note.length).toBeLessThan(200);
            });

            await it('truncates over-long input to under 200 chars', async () => {
                const note = buildAiNoteRationale({
                    date: '2026-07-09',
                    model: 'claude-x',
                    correspondentName: 'X'.repeat(300),
                    documentTypeName: 'Y'.repeat(300),
                });
                expect(note.length).toBeLessThan(200);
                expect(note).toContain('…');
            });
        });

        await describe('applyAiNoteToPayload', async () => {
            await it('adds the ai_note entry while preserving other custom fields', async () => {
                const payload: { custom_fields?: Array<{ field: number; value: unknown }> } = {
                    custom_fields: [{ field: 5, value: 'INV-1' }],
                };
                applyAiNoteToPayload(payload, 42, 'KI-Review 2026-07-09: …');
                expect(payload.custom_fields).toHaveLength(2);
                const invoice = payload.custom_fields?.find((c) => c.field === 5);
                const aiNote = payload.custom_fields?.find((c) => c.field === 42);
                expect(invoice?.value).toBe('INV-1');
                expect(aiNote?.value).toBe('KI-Review 2026-07-09: …');
            });

            await it('overwrites a prior ai_note (fresh rationale each review)', async () => {
                const payload: { custom_fields?: Array<{ field: number; value: unknown }> } = {
                    custom_fields: [
                        { field: 42, value: 'stale note' },
                        { field: 5, value: 'INV-1' },
                    ],
                };
                applyAiNoteToPayload(payload, 42, 'fresh note');
                const aiNotes = payload.custom_fields?.filter((c) => c.field === 42) ?? [];
                expect(aiNotes).toHaveLength(1);
                expect(aiNotes[0]?.value).toBe('fresh note');
                // other field survives
                expect(payload.custom_fields?.find((c) => c.field === 5)?.value).toBe('INV-1');
            });

            await it('is a no-op when the ai_note field id is not configured', async () => {
                const payload: { custom_fields?: Array<{ field: number; value: unknown }> } = {
                    custom_fields: [{ field: 5, value: 'INV-1' }],
                };
                applyAiNoteToPayload(payload, 0, 'ignored');
                expect(payload.custom_fields).toHaveLength(1);
                expect(payload.custom_fields?.[0]?.field).toBe(5);
            });
        });

        await describe('commitDocumentUpdate (dry-run gate)', async () => {
            await it('does NOT write in dry-run mode', async () => {
                let calls = 0;
                const wrote = await commitDocumentUpdate(
                    123,
                    { custom_fields: [{ field: 42, value: 'note' }] } as Parameters<typeof commitDocumentUpdate>[1],
                    { dryRun: true },
                    silentLog,
                    async () => {
                        calls += 1;
                    },
                );
                expect(calls).toBe(0);
                expect(wrote).toBe(false);
            });

            await it('writes the payload (incl. ai_note) when not in dry-run', async () => {
                let calls = 0;
                let seen: unknown = null;
                const payload = { custom_fields: [{ field: 42, value: 'note' }] } as Parameters<
                    typeof commitDocumentUpdate
                >[1];
                const wrote = await commitDocumentUpdate(123, payload, { dryRun: false }, silentLog, async (_id, p) => {
                    calls += 1;
                    seen = p;
                });
                expect(calls).toBe(1);
                expect(wrote).toBe(true);
                const seenFields = (seen as { custom_fields?: Array<{ field: number; value: unknown }> }).custom_fields;
                expect(seenFields?.some((c) => c.field === 42)).toBe(true);
            });
        });
    });
};
