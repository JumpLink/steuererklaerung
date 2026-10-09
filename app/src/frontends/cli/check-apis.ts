import type { CommandModule } from 'yargs';

import { checkApis } from '../../core/actions/index.ts';

export const checkApisCommand: CommandModule = {
    command: 'check-apis',
    describe: 'Test connectivity to Qonto, Paperless-NGX, INWX and FinTS',
    handler: () => {
        checkApis({})
            .then((ok) => process.exit(ok ? 0 : 1))
            .catch((err) => {
                console.error(err);
                process.exit(1);
            });
    },
};
