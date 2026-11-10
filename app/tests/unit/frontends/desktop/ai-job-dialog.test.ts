/**
 * Pure helper for the reusable AI-job runner dialog: plural-aware summary lines.
 * The dialog itself is GTK and is covered by the core-action cancellation tests; this file tests
 * the part that can run headless.
 */
import { describe, it, expect } from '@gjsify/unit';
import { aiJobSummaryLines } from '../../../../src/frontends/desktop/widgets/ai-job-summary.ts';

export default async () => {
    await describe('aiJobSummaryLines', async () => {
        await it('builds a plural-aware summary', () => {
            const lines = aiJobSummaryLines({ processed: 5, updated: 3, changed: 2, skipped: 1, errors: 1 });
            expect(lines).toContain('5 documents processed');
            expect(lines).toContain('3 updated');
            expect(lines).toContain('2 changed');
            expect(lines).toContain('1 document skipped');
            expect(lines).toContain('1 error');
        });

        await it('uses singular forms for one item', () => {
            const lines = aiJobSummaryLines({ processed: 1, updated: 1, changed: 1, skipped: 1 });
            expect(lines).toContain('1 document processed');
            expect(lines).toContain('1 updated');
            expect(lines).toContain('1 changed');
            expect(lines).toContain('1 document skipped');
        });

        await it('omits the error line when there are none', () => {
            const lines = aiJobSummaryLines({ processed: 1, updated: 1 });
            expect(lines).toContain('1 document processed');
            expect(lines).toContain('1 updated');
            expect(lines.every((l) => !l.includes('error'))).toBe(true);
        });

        await it('omits optional counters when they are undefined', () => {
            const lines = aiJobSummaryLines({ processed: 2 });
            expect(lines).toHaveLength(1);
            expect(lines[0]).toBe('2 documents processed');
        });
    });
};
