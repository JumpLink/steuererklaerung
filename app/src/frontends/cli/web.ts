import type { CommandModule } from 'yargs';

export const webCommand: CommandModule = {
    command: 'web',
    describe:
        'Start the read-only review web UI (transactions + Belege, Steuer-Übersicht). Multi-entity via the consolidated steuererklaerung.json manifest.',
    builder: (y) =>
        y
            .option('port', { type: 'number', default: 3000, describe: 'HTTP port (localhost only)' })
            .option('host', { type: 'string', default: '127.0.0.1', describe: 'Bind host (default localhost)' })
            .option('years', { type: 'string', describe: 'Tax years to load, comma-separated (default: config year)' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const years =
            typeof raw.years === 'string'
                ? raw.years
                      .split(',')
                      .map((s) => Number(s.trim()))
                      .filter((n) => Number.isFinite(n))
                : undefined;
        const { startWebServer } = await import('../web/server.ts');
        // Never settles — the GLib loop (index.ts) keeps the server I/O flowing.
        await startWebServer({ port: raw.port as number, host: raw.host as string, years });
    },
};
