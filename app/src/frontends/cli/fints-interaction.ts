/**
 * The terminal's answer to a bank's questions — the CLI half of the {@link FinTSInteraction} seam.
 *
 * This is the behaviour the FinTS client used to carry inline: readline on stdin, progress on
 * stderr. It lives here now because a terminal prompt is a property of the terminal frontend, not
 * of the FinTS protocol, and keeping it in the client is what made the native app unable to
 * complete a single sync.
 */

import { createInterface } from 'node:readline';

import type { FinTSInteraction, PinRequest, TanRequest } from '../../core/clients/fints/interaction.ts';

function prompt(question: string, hidden = false): Promise<string> {
    return new Promise((resolve) => {
        if (hidden) {
            // Write the prompt manually, then read without echo.
            process.stderr.write(question);
            const rl = createInterface({ input: process.stdin, terminal: false });
            rl.once('line', (answer) => {
                process.stderr.write('\n');
                rl.close();
                resolve(answer);
            });
        } else {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        }
    });
}

export const terminalFinTSInteraction: FinTSInteraction = {
    async requestTan(request: TanRequest): Promise<string> {
        if (request.challenge) process.stderr.write(`\nTAN Challenge: ${request.challenge}\n`);
        return prompt('TAN eingeben: ');
    },
    requestPin(request: PinRequest): Promise<string> {
        return prompt(`PIN for "${request.accountName}" (${request.blz}): `, true);
    },
    notify(message: string): void {
        process.stderr.write(`${message}\n`);
    },
};
