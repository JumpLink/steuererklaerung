import { describe, it, expect } from '@gjsify/unit';
import { DEFAULT_APP_NAME, DESKTOP_ENTRY, notificationHintValues } from '../../../src/core/notify/hints.ts';

export default async () => {
    await describe('notificationHintValues', async () => {
        await it('names the desktop entry so the shell groups the reminders', async () => {
            expect(notificationHintValues('critical').desktopEntry).toBe('eu.jumplink.Steuererklaerung');
            expect(DESKTOP_ENTRY).toBe('eu.jumplink.Steuererklaerung');
        });

        await it('maps urgency to the specification byte, normal by default', async () => {
            expect(notificationHintValues('low').urgency).toBe(0);
            expect(notificationHintValues().urgency).toBe(1);
            expect(notificationHintValues('critical').urgency).toBe(2);
        });

        await it('defaults the sender to the display name, not the command name', async () => {
            expect(DEFAULT_APP_NAME).toBe('Steuererklärung');
        });
    });
};
