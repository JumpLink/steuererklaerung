import { describe, it, expect } from '@gjsify/unit';
import { z } from 'zod';
import { extractJsonCandidate, parseJsonLeniently, parseJsonWithSchema } from '@steuererklaerung/shared';

export default async () => {
    await describe('extractJsonCandidate', async () => {
        await it('returns plain JSON unchanged', async () => {
            expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
        });
        await it('strips markdown fences', async () => {
            expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
        });
        await it('slices JSON out of surrounding prose', async () => {
            expect(extractJsonCandidate('Sure! {"a":1} done')).toBe('{"a":1}');
        });
        await it('returns null when no object present', async () => {
            expect(extractJsonCandidate('no json here')).toBeNull();
        });
    });

    await describe('parseJsonLeniently', async () => {
        await it('parses strict JSON', async () => {
            expect(parseJsonLeniently('{"a":1}')).toStrictEqual({ a: 1 });
        });
        await it('repairs trailing commas', async () => {
            expect(parseJsonLeniently('{"a":1,}')).toStrictEqual({ a: 1 });
        });
        await it('returns undefined for empty/garbage input', async () => {
            expect(parseJsonLeniently('')).toBeUndefined();
        });
    });

    await describe('parseJsonWithSchema', async () => {
        const schema = z.object({ payment_status: z.string(), amount: z.number().nullable() });

        await it('validates a fenced reply with extra prose', async () => {
            const raw = 'Here:\n```json\n{"payment_status":"offen","amount":85.93,"extra":"x"}\n```';
            const r = parseJsonWithSchema(raw, schema);
            expect(r.success).toBe(true);
            if (r.success) expect(r.data).toStrictEqual({ payment_status: 'offen', amount: 85.93 });
        });

        await it('fails clearly on schema mismatch', async () => {
            const r = parseJsonWithSchema('{"amount": 1}', schema);
            expect(r.success).toBe(false);
            if (!r.success) expect(r.error).toMatch(/payment_status/);
        });

        await it('fails on empty input', async () => {
            expect(parseJsonWithSchema(undefined, schema).success).toBe(false);
        });
    });
};
