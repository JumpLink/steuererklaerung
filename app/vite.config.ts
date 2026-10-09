import { defineConfig } from 'vite';
import { gjsifyBrowser } from '@gjsify/vite-plugin-gjsify';

// Browser frontend for the read-only review UI. Built with gjsify's Vite preset
// (`gjsifyBrowser` mirrors `gjsify build --app browser`). Output → dist/web, served
// by the Hono server (src/frontends/web/server.ts). Dev: `vite` proxies /api → the Hono server.
export default defineConfig({
    root: 'src/frontends/web/client',
    plugins: [...gjsifyBrowser()],
    server: {
        port: 5173,
        proxy: { '/api': 'http://127.0.0.1:3000' },
    },
    build: {
        outDir: '../../../../dist/web',
        emptyOutDir: true,
    },
});
