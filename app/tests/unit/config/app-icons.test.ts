/**
 * Where the application icon is looked up. The bundle sits at `<app>/dist/app/`, the source at
 * `<app>/src/frontends/desktop/`: a fixed number of levels up found the icons in one and the
 * missing-image placeholder in the other.
 */

import { describe, expect, it } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { iconsDir } from '../../../src/core/lib/icons-dir.ts';

export default async () => {
    await describe('iconsDir', async () => {
        await it('finds data/icons from the bundle directory and from the source directory', async () => {
            const root = realpathSync(mkdtempSync(join(tmpdir(), 'steuer-icons-')));
            try {
                const icons = join(root, 'data', 'icons');
                mkdirSync(icons, { recursive: true });
                const bundle = join(root, 'dist', 'app');
                const source = join(root, 'src', 'frontends', 'desktop');
                mkdirSync(bundle, { recursive: true });
                mkdirSync(source, { recursive: true });
                expect(iconsDir(bundle)).toBe(icons);
                expect(iconsDir(source)).toBe(icons);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
