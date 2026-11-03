/**
 * The ordering rule behind `check:breakpoints`. The case that matters is the last one: the phone
 * rung placed before the collapse rung, which is what a ladder read top-down invites you to write
 * and which libadwaita then never reaches.
 */
import { describe, it, expect } from '@gjsify/unit';

import { orderProblems, scanBreakpoints } from '../../../dev/breakpoint-scan.ts';

const WINDOW = [
    'template $BhMainWindow: Adw.ApplicationWindow {',
    '  [breakpoint]',
    '  Adw.Breakpoint {',
    '    condition ("min-width: 1180px")',
    '    setters { assistant_split.collapsed: false; }',
    '  }',
    '  [breakpoint]',
    '  Adw.Breakpoint {',
    '    condition ("max-width: 720px")',
    '    setters { split_view.collapsed: true; }',
    '  }',
    '  [breakpoint]',
    '  Adw.Breakpoint phone_breakpoint {',
    '    condition ("max-width: 480px")',
    '    setters { split_view.collapsed: true; }',
    '  }',
    '}',
].join('\n');

const INVERTED = [
    '  Adw.Breakpoint {',
    '    condition ("max-width: 480px")',
    '  }',
    '  Adw.Breakpoint {',
    '    condition ("max-width: 720px")',
    '  }',
].join('\n');

export default async () => {
    await describe('breakpoint scan', async () => {
        await it('reads the conditions in document order', async () => {
            const found = scanBreakpoints(WINDOW);
            expect(found.length).toBe(3);
            expect(found[0].minWidth).toBe(1180);
            expect(found[0].maxWidth).toBe(null);
            expect(found[1].maxWidth).toBe(720);
            expect(found[2].maxWidth).toBe(480);
        });

        await it('ignores a condition that only appears in a comment', async () => {
            const commented = [
                '// condition ("max-width: 480px")',
                '/* condition ("max-width: 300px") */',
                WINDOW,
            ].join('\n');
            expect(scanBreakpoints(commented).length).toBe(3);
        });

        await it('keeps line numbers usable after stripping comments', async () => {
            const found = scanBreakpoints(['// a comment', '/* two', '   lines */', WINDOW].join('\n'));
            expect(found[0].line).toBe(7);
        });
    });

    await describe('breakpoint order', async () => {
        await it('accepts the ladder from window.blp', async () => {
            expect(orderProblems(scanBreakpoints(WINDOW)).length).toBe(0);
        });

        await it('rejects a narrow rung placed before a wider one', async () => {
            const problems = orderProblems(scanBreakpoints(INVERTED));
            expect(problems.length).toBe(1);
            expect(problems[0].includes('max-width: 720px')).toBe(true);
            expect(problems[0].includes('narrowest last')).toBe(true);
        });

        await it('rejects two min-width rungs in descending order', async () => {
            const problems = orderProblems(
                scanBreakpoints('condition ("min-width: 1180px") condition ("min-width: 900px")'),
            );
            expect(problems.length).toBe(1);
            expect(problems[0].includes('widest last')).toBe(true);
        });

        await it('says nothing about a single rung', async () => {
            expect(orderProblems(scanBreakpoints('condition ("max-width: 450px")')).length).toBe(0);
        });
    });
};
