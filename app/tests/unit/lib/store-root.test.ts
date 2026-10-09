import { describe, it, expect } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findStoreAncestor } from '@steuererklaerung/store';

/**
 * Where the transaction store lives must be ANSWERED, not counted.
 *
 * `packageRoot()` used to hop a fixed number of directories up from this module — one for a
 * `dist/<bundle>`, three for the source tree. Both numbers were right only for the layout that
 * existed when they were written. The desktop app builds one level deeper
 * (`dist/app/steuer-app.gjs.mjs`), so its up-1 landed in `dist/`, the store resolved to a
 * `dist/transactions-data` that does not exist, and libgda refused the connection — "Der
 * DB_DIR-Teil der Verbindungszeichenkette muss auf einen gültigen Ordner verweisen". The whole
 * Steuererklärung view failed to load in the app while the CLI, one level shallower and so
 * accidentally correct, kept working.
 *
 * The replacement walks up until it FINDS the store, which cannot be off by one.
 */
export default async () => {
    await describe('findStoreAncestor', async () => {
        const root = mkdtempSync(join(tmpdir(), 'store-root-'));
        // <root>/app/transactions-data — the real shape, with both bundle dirs beneath it.
        const pkg = join(root, 'app');
        mkdirSync(join(pkg, 'transactions-data'), { recursive: true });
        mkdirSync(join(pkg, 'dist', 'app'), { recursive: true });

        await it('finds the root from the CLI bundle directory', async () => {
            expect(findStoreAncestor(join(pkg, 'dist'))).toBe(pkg);
        });

        await it('finds the root from the DEEPER desktop bundle directory', async () => {
            // The regression: one level deeper than the CLI. Counting one hop up from here
            // yields <pkg>/dist, which has no store — this is the case that broke the app.
            expect(findStoreAncestor(join(pkg, 'dist', 'app'))).toBe(pkg);
        });

        await it('finds the root from arbitrarily deep nesting', async () => {
            // The point of searching rather than counting: no depth is special.
            const deep = join(pkg, 'dist', 'a', 'b', 'c');
            mkdirSync(deep, { recursive: true });
            expect(findStoreAncestor(deep)).toBe(pkg);
        });

        await it('returns the directory itself when it already holds the store', async () => {
            expect(findStoreAncestor(pkg)).toBe(pkg);
        });

        await it('answers null when no ancestor holds a store', async () => {
            // The discriminator: the search must be able to FAIL. A function that always
            // returned some directory would satisfy every assertion above.
            const bare = mkdtempSync(join(tmpdir(), 'store-none-'));
            const nested = join(bare, 'x', 'y');
            mkdirSync(nested, { recursive: true });
            expect(findStoreAncestor(nested)).toBe(null);
            rmSync(bare, { recursive: true, force: true });
        });

        rmSync(root, { recursive: true, force: true });
    });
};
