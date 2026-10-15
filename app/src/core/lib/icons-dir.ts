/**
 * The shipped icon-theme root (`<app>/data/icons`), found from the directory of the calling module
 * so it is correct from any cwd and in both the source and the bundled form — same trick as
 * `demoDir` in core/config/demo.ts. Kept free of GTK so a test can import it.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function iconsDir(start: string): string {
    let dir = start;
    // Bounded search for `data/icons`: `<app>/src/frontends/desktop` is three up, the bundle in
    // `<app>/dist/app` only two (a fixed "one up" once landed in the non-existent `dist/data`
    // and the About dialog showed the missing-image placeholder). Six is room to spare.
    for (let up = 0; up < 6; up++) {
        const candidate = join(dir, 'data', 'icons');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return join(start, 'data', 'icons');
}
