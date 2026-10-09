import { describe, it, expect } from '@gjsify/unit';
import {
    finTSInteraction,
    setFinTSInteraction,
    type FinTSInteraction,
} from '../../../src/core/clients/fints/interaction.ts';

const recording = (): FinTSInteraction & { asked: string[] } => {
    const asked: string[] = [];
    return {
        asked,
        async requestTan(r) {
            asked.push(`tan:${r.accountName}:${r.challenge ?? '-'}`);
            return '123456';
        },
        async requestPin(r) {
            asked.push(`pin:${r.accountName}`);
            return 'secret';
        },
        notify(m) {
            asked.push(`notify:${m}`);
        },
    };
};

export default async () => {
    await describe('FinTS interaction seam', async () => {
        await it('refuses by default instead of reading a stdin nobody is typing into', async () => {
            // A surface that forgot to register must FAIL, not hang on an invisible prompt.
            let message = '';
            try {
                await finTSInteraction().requestTan({ accountName: 'bank' });
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('Keine TAN-Eingabe')).toBe(true);

            message = '';
            try {
                await finTSInteraction().requestPin({ accountName: 'bank', blz: '10010010' });
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('Keine PIN-Eingabe')).toBe(true);
        });

        await it('routes the bank question to whichever surface registered', async () => {
            const ui = recording();
            const previous = setFinTSInteraction(ui);
            try {
                const tan = await finTSInteraction().requestTan({ accountName: 'giro', challenge: 'Auftrag 1' });
                const pin = await finTSInteraction().requestPin({ accountName: 'giro', blz: '10010010' });
                finTSInteraction().notify('warte');
                expect(tan).toBe('123456');
                expect(pin).toBe('secret');
                expect(ui.asked).toStrictEqual(['tan:giro:Auftrag 1', 'pin:giro', 'notify:warte']);
            } finally {
                setFinTSInteraction(previous);
            }
        });

        await it('gives the previous provider back, so registering is reversible', async () => {
            const first = recording();
            const original = setFinTSInteraction(first);
            const second = recording();
            const returned = setFinTSInteraction(second);
            expect(returned).toBe(first);
            setFinTSInteraction(original);
            // Back to the refusing default.
            let threw = false;
            try {
                await finTSInteraction().requestTan({ accountName: 'x' });
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });
    });
};
