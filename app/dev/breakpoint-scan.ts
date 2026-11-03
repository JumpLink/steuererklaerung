/**
 * The ordering rule for `Adw.Breakpoint` ladders, as a pure function so it can be tested on
 * strings instead of on the real templates. The filesystem side is `check-breakpoints.js`.
 *
 * WHY THIS EXISTS, learnt while adding the phone rung on 2026-11-03:
 * `adw_breakpoint_bin_size_allocate` walks the breakpoints in REVERSE order of addition and stops
 * at the FIRST whose condition holds. Only that one's setters run; `current-breakpoint` is a
 * single breakpoint, not a set. So a ladder is not cumulative, and a narrower rung declared BEFORE
 * a wider one is unreachable: at 360px a `max-width: 720px` rung listed later matches first, and
 * the `max-width: 480px` rung above it never applies.
 *
 * Nothing else catches that. Blueprint compiles both orders, GtkBuilder builds both, the app runs,
 * and the window simply keeps the wider layout — which on a phone looks like a layout bug in the
 * view, not like an ordering bug in the template.
 */

/** One `Adw.Breakpoint` as it appears in a template, in document order. */
export interface ScannedBreakpoint {
    /** The text inside `condition (...)`, comments already removed. */
    condition: string;
    /** Line number of the `condition (...)`, 1-based, for the message. */
    line: number;
    /** The `max-width: Npx` limit, or null when the condition does not name one. */
    maxWidth: number | null;
    /** The `min-width: Npx` limit, or null when the condition does not name one. */
    minWidth: number | null;
}

/** Blueprint comments, removed before matching so prose about a condition is not a condition. */
export function stripComments(source: string): string {
    // Replaced by blanks rather than deleted: line numbers have to survive, they go in the message.
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const CONDITION = /condition\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;

/**
 * Every breakpoint condition in `source`, in document order.
 *
 * Only `min-width`/`max-width` in pixels are extracted — height conditions and the `sp` unit are
 * left as null, because the rule below has nothing to say about them. A compound condition
 * (`and`/`or`) contributes its first width of each kind; this app writes none, and the day it does
 * the check should be extended rather than trusted.
 */
export function scanBreakpoints(source: string): ScannedBreakpoint[] {
    const clean = stripComments(source);
    const out: ScannedBreakpoint[] = [];
    for (const match of clean.matchAll(CONDITION)) {
        const condition = match[2].trim();
        const max = /max-width\s*:\s*(\d+)\s*px/.exec(condition);
        const min = /min-width\s*:\s*(\d+)\s*px/.exec(condition);
        out.push({
            condition,
            line: clean.slice(0, match.index).split('\n').length,
            maxWidth: max ? Number.parseInt(max[1], 10) : null,
            minWidth: min ? Number.parseInt(min[1], 10) : null,
        });
    }
    return out;
}

/**
 * The rule: the LAST matching rung wins, so the rungs have to get more specific downwards.
 *
 * `max-width` limits must strictly descend in document order (the narrowest last), `min-width`
 * limits must strictly ascend (the widest last). The two kinds are checked separately — they do
 * not compete in any ladder this app has, and interleaving them is how the file stays readable.
 */
export function orderProblems(breakpoints: ScannedBreakpoint[]): string[] {
    const problems: string[] = [];

    const check = (
        kind: 'max-width' | 'min-width',
        pick: (b: ScannedBreakpoint) => number | null,
        wrong: (previous: number, current: number) => boolean,
        last: string,
    ) => {
        const rungs = breakpoints.filter((b) => pick(b) !== null);
        for (let i = 1; i < rungs.length; i++) {
            const previous = pick(rungs[i - 1]) as number;
            const current = pick(rungs[i]) as number;
            if (wrong(previous, current)) {
                problems.push(
                    `line ${rungs[i].line}: \`${rungs[i].condition}\` comes after \`${rungs[i - 1].condition}\`, ` +
                        `so it can never apply — ${kind} rungs must be ordered with the ${last} last`,
                );
            }
        }
    };

    check(
        'max-width',
        (b) => b.maxWidth,
        (previous, current) => current >= previous,
        'narrowest',
    );
    check(
        'min-width',
        (b) => b.minWidth,
        (previous, current) => current <= previous,
        'widest',
    );

    return problems;
}
