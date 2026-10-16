import { getEricStatus } from '../../../core/actions/elster/eric-status.ts';
import { ERIC_DOWNLOAD_URL, ericVersionLabel, ericWarningText } from '../../../core/actions/elster/eric-warnings.ts';
import { fmt, _ } from '../../../core/lib/i18n.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster eric` — which ERiC the app would use, its version in both numberings (release as on
 * ELSTER's download page, library as the binary reports it) and whether it looks out of date. The
 * hint never changes the exit code: whether ELSTER accepts a send is ELSTER's call.
 */
export const ericSubcommand: YargsCommandModule = {
    command: 'eric',
    describe: 'Show the ERiC in use, its version and whether it is out of date.',
    builder: (y) => y.option('json', { type: 'boolean', default: false, describe: 'Print raw JSON' }),
    handler: async (raw) => {
        const status = await getEricStatus();
        if (raw.json === true) {
            console.log(JSON.stringify(status, null, 2));
            return process.exit(0);
        }
        if (!status.available) {
            console.log(
                status.error
                    ? fmt(_('ERiC cannot be loaded: {error}'), { error: status.error })
                    : fmt(_('ERiC not found under {path}.'), { path: status.libPath }),
            );
            return process.exit(1);
        }
        console.log(ericVersionLabel(status.version) ?? _('ERiC version unknown'));
        console.log(fmt(_('Location: {path}'), { path: status.ericHome }));
        console.log(fmt(_('Check plugins: {count}'), { count: status.pluginCount }));
        for (const w of status.warnings) console.log(`⚠ ${ericWarningText(w)}`);
        if (status.warnings.length > 0 && !status.bundled) console.log(ERIC_DOWNLOAD_URL);
        process.exit(0);
    },
};
