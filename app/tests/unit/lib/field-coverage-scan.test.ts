/**
 * The scanner behind `check:fields` — the three ways it used to report green over a real gap:
 * camelCase names and formatter-broken chains were never seen as fields, and `field:` in a type or
 * a comment counted as a row in the UI.
 */
import { describe, it, expect } from '@gjsify/unit';

import { mentions, schemaLeaves, stripNonCode } from '../../../dev/field-coverage-scan.ts';

const SCHEMA = [
    'export const EntitySchema = z.object({',
    '    taxModule: z.enum(TAX_MODULES).optional(),',
    '    allowWrite: z.boolean().default(false),',
    '    widnr: z',
    '        .string()',
    '        .regex(/x/)',
    '        .optional(),',
    '    bank: z',
    '        .object({',
    '            iban: z.string().optional(),',
    '        })',
    '        .optional(),',
    '    tags: z.array(z.string()).default([]),',
    '    rows: z.array(RowSchema).default([]),',
    '    list: z',
    '        .array(',
    '            z.object({',
    '                note: z.string(),',
    '            }),',
    '        )',
    '        .default([]),',
    '});',
].join('\n');

export default async () => {
    await describe('check:fields — schema leaves', async () => {
        const leaves = schemaLeaves(SCHEMA);

        await it('sees camelCase fields', async () => {
            expect(leaves.has('taxModule')).toBe(true);
            expect(leaves.has('allowWrite')).toBe(true);
        });

        await it('sees a chain the formatter broke across lines', async () => {
            expect(leaves.get('widnr')?.line).toBe(4);
            expect(leaves.get('widnr')?.block).toBe('EntitySchema');
        });

        await it('skips containers, keeps lists of plain values and nested leaves', async () => {
            expect(leaves.has('bank')).toBe(false);
            expect(leaves.has('rows')).toBe(false);
            expect(leaves.has('list')).toBe(false);
            expect(leaves.has('tags')).toBe(true);
            expect(leaves.has('iban')).toBe(true);
            expect(leaves.has('note')).toBe(true);
        });
    });

    await describe('check:fields — mentions', async () => {
        await it('does not count a type annotation as a surface', async () => {
            const code = stripNonCode('interface Choice {\n    country: string;\n    taxModule: TaxModuleId;\n}');
            expect(mentions(code, 'country')).toBe(false);
            expect(mentions(code, 'taxModule')).toBe(false);
        });

        await it('does not count comments or prose strings', async () => {
            const code = stripNonCode("// country: DE\nconst s = 'set the country: here';\n/* taxModule */");
            expect(mentions(code, 'country')).toBe(false);
            expect(mentions(code, 'taxModule')).toBe(false);
        });

        await it('counts property access, object keys with a value and identifier strings', async () => {
            expect(mentions(stripNonCode('if (entity.taxModule === "de") {}'), 'taxModule')).toBe(true);
            expect(mentions(stripNonCode("apply({ country: 'DE' });"), 'country')).toBe(true);
            expect(mentions(stripNonCode("set('vatId', v);"), 'vatId')).toBe(true);
        });

        await it('counts a field read inside a template expression', async () => {
            expect(mentions(stripNonCode('const s = `${pct(a.g.quote)} %`;'), 'quote')).toBe(true);
        });

        await it('does not match a field name inside a longer word', async () => {
            expect(mentions(stripNonCode('x.capacity = 1;'), 'city')).toBe(false);
        });
    });
};
