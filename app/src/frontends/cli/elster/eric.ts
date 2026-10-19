import { applyEricHome, getEricStatus } from '../../../core/actions/elster/eric-status.ts';
import {
    ERIC_DOWNLOAD_URL,
    ericSourceLabel,
    ericVersionLabel,
    ericWarningText,
} from '../../../core/actions/elster/eric-warnings.ts';
import { loadManifest, resolveEntityElster, saveEricHome } from '../../../core/config/index.ts';
import { defaultEntityFor, requireEntity } from '../../../core/config/entities.ts';
import { fmt, _ } from '../../../core/lib/i18n.ts';
import { pickArgv } from '../output.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster eric` — which ERiC the app would use, its version in both numberings (release as on
 * ELSTER's download page, library as the binary reports it) and whether it looks out of date. The
 * hint never changes the exit code: whether ELSTER accepts a send is ELSTER's call.
 */
export const ericSubcommand: YargsCommandModule = {
    command: 'eric',
    describe: 'Show the ERiC in use, its version and whether it is out of date.',
    builder: (y) =>
        y
            .option('json', { type: 'boolean', default: false, describe: 'Print raw JSON' })
            .option('set-home', {
                type: 'string',
                describe: 'Use this ERiC folder (saved as eric_home in the config; ranks like ERIC_HOME)',
            })
            .option('reset-home', {
                type: 'boolean',
                default: false,
                describe: 'Forget the own ERiC folder and fall back to ERIC_HOME / bundled / auto-detection',
            }),
    handler: async (raw) => {
        const entityId = pickArgv<string>(raw, 'entity');
        const setHome = pickArgv<string>(raw, 'set-home');
        try {
            const manifest = loadManifest();
            const id = (entityId ? requireEntity(manifest, entityId) : defaultEntityFor(manifest)).id;
            if (setHome !== undefined || raw['reset-home'] === true) {
                saveEricHome(id, raw['reset-home'] === true ? '' : (setHome ?? ''));
            }
            const elster = resolveEntityElster(id);
            if (elster) applyEricHome(elster);
        } catch (err) {
            // No manifest (or no ELSTER config) is fine for a probe — but a requested write must not vanish.
            if (setHome !== undefined || raw['reset-home'] === true) {
                console.error(err instanceof Error ? err.message : String(err));
                return process.exit(1);
            }
        }
        const status = await getEricStatus();
        if (raw.json === true) {
            console.log(JSON.stringify(status, null, 2));
            return process.exit(0);
        }
        if (!status.available) {
            console.log(
                status.ffiMissing
                    ? fmt(
                          _('The FFI module (koffi) is missing from this installation, ERiC cannot be loaded: {error}'),
                          {
                              error: status.error ?? '',
                          },
                      )
                    : status.error
                      ? fmt(_('ERiC cannot be loaded: {error}'), { error: status.error })
                      : fmt(_('ERiC not found under {path}.'), { path: status.libPath }),
            );
            return process.exit(1);
        }
        console.log(ericVersionLabel(status.version) ?? _('ERiC version unknown'));
        console.log(fmt(_('Location: {path}'), { path: status.ericHome }));
        console.log(fmt(_('Source: {source}'), { source: ericSourceLabel(status.source) }));
        console.log(fmt(_('Check plugins: {count}'), { count: status.pluginCount }));
        for (const w of status.warnings) console.log(`⚠ ${ericWarningText(w)}`);
        if (status.warnings.length > 0 && !status.bundled) console.log(ERIC_DOWNLOAD_URL);
        process.exit(0);
    },
};
