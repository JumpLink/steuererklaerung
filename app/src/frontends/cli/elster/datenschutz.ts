import {
    acknowledgePrivacy,
    logFileNoticeText,
    privacyNoticeText,
    readPrivacyAck,
} from '../../../core/actions/elster/privacy-ack.ts';
import { getEricStatus } from '../../../core/actions/elster/eric-status.ts';
import { fmt, _ } from '../../../core/lib/i18n.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster datenschutz` — the privacy notice the ERiC licence (§ 5) requires before the first send.
 * Without `--bestaetigen` it prints the notice and the log-file note (§ 15) and says whether it was
 * confirmed already; with it, it records the confirmation that unlocks test and live sends. The
 * desktop app asks the same thing in a dialog right before the first send.
 */
export const datenschutzSubcommand: YargsCommandModule = {
    command: 'datenschutz',
    describe:
        'Datenschutzhinweis der Finanzverwaltung (ERiC-Lizenz § 5) anzeigen und mit --bestaetigen als gelesen bestätigen — Voraussetzung für jeden ELSTER-Versand.',
    builder: (y) =>
        y.option('bestaetigen', {
            type: 'boolean',
            default: false,
            describe: 'Kenntnisnahme bestätigen (schaltet Test- und Echt-Versand frei).',
        }),
    handler: async (raw) => {
        const status = await getEricStatus();
        console.log(privacyNoticeText());
        console.log('');
        console.log(fmt(logFileNoticeText(), { path: status.logPath }));
        console.log('');
        if (raw.bestaetigen === true) {
            const ack = acknowledgePrivacy();
            console.log(fmt(_('Confirmed on {date}.'), { date: ack.acknowledgedAt }));
            return process.exit(0);
        }
        const ack = readPrivacyAck();
        console.log(
            ack
                ? fmt(_('Already confirmed on {date}.'), { date: ack.acknowledgedAt })
                : _('Not confirmed yet. Run again with --bestaetigen once you have read it.'),
        );
        process.exit(0);
    },
};
