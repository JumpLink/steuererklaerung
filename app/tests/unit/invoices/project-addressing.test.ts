import { describe, expect, it } from '@gjsify/unit';
import type { Project, RecurringInvoice } from '../../../src/core/config/index.ts';
import {
    buildHeaderWithWarnings,
    DEFAULT_HEADER_TEMPLATE,
    DEFAULT_HEADER_TEMPLATE_SIE,
    GREETING_MISSING,
    resolveAddressing,
} from '../../../src/core/invoices/header-template.ts';

function schedule(over: Partial<RecurringInvoice> = {}): RecurringInvoice {
    return {
        id: 'beispiel-hosting',
        entityId: 'muster',
        status: 'active',
        customer: { name: 'Beispiel GmbH', contactId: 'c_beispiel' },
        description: 'Website Hosting beispiel.de',
        domains: ['beispiel.de'],
        intervalMonths: 12,
        nextPeriod: { start: '2026-01-01', end: '2026-12-31' },
        reminderLeadDays: 28,
        currency: 'EUR',
        items: [{ title: 'Hosting', quantity: 1, unitPrice: 108, vatRate: 19 }],
        ...over,
    };
}

function project(contactPerson?: Project['contactPerson']): Project {
    return {
        id: 'beispiel-website',
        name: 'Website',
        contactId: 'c_beispiel',
        domains: ['beispiel.de'],
        contactPerson,
    };
}

const DEFAULTS = {
    defaultHeader: DEFAULT_HEADER_TEMPLATE,
    defaultHeaderSie: DEFAULT_HEADER_TEMPLATE_SIE,
    issuerName: 'Muster Einzelunternehmen',
};

export default async () => {
    await describe('Anrede-Kette: Projekt → Vertrag → leer', async () => {
        await it('Stufe 1: die Kontaktperson des Projekts gewinnt gegen den Vertrag', () => {
            const a = resolveAddressing(
                schedule({ customer: { name: 'Beispiel GmbH', greeting: 'Vertragsname' } }),
                project({ greeting: 'Silke' }),
            );
            expect(a.greeting).toBe('Silke');
            expect(a.greetingFrom).toBe('project');
        });

        await it('Stufe 2: ohne Projekt-Anrede gilt customer.greeting des Vertrags', () => {
            const inv = schedule({ customer: { name: 'Beispiel GmbH', greeting: 'Markus' } });
            expect(resolveAddressing(inv, project({ firstName: 'Silke' })).greeting).toBe('Markus');
            expect(resolveAddressing(inv, project()).greetingFrom).toBe('contract');
            expect(resolveAddressing(inv).greetingFrom).toBe('contract');
        });

        await it('Stufe 3: ohne beides bleibt die Anrede leer, mit Warnung — der Kundenname springt nie ein', () => {
            const a = resolveAddressing(schedule(), project({ firstName: 'Silke' }));
            expect(a.greeting).toBe('');
            expect(a.greetingFrom).toBe('none');
            const rendered = buildHeaderWithWarnings(schedule(), DEFAULTS, project());
            expect(rendered?.warnings).toStrictEqual([GREETING_MISSING]);
            expect(rendered?.text.startsWith('Hallo,')).toBe(true);
            expect(rendered?.text.includes('Beispiel GmbH')).toBe(false);
        });

        await it('eine leere Projekt-Anrede zählt als nicht gesetzt', () => {
            const inv = schedule({ customer: { name: 'Beispiel GmbH', greeting: 'Markus' } });
            expect(resolveAddressing(inv, project({ greeting: '   ' })).greeting).toBe('Markus');
        });
    });

    await describe('Du/Sie folgt derselben Kette', async () => {
        await it('Projekt-Form gewinnt, dann der Vertrag, Default du', () => {
            const sieVertrag = schedule({ customer: { name: 'Beispiel GmbH', formality: 'sie' } });
            expect(resolveAddressing(sieVertrag, project({ formality: 'du' })).formality).toBe('du');
            expect(resolveAddressing(sieVertrag, project({ greeting: 'Silke' })).formality).toBe('sie');
            expect(resolveAddressing(sieVertrag).formality).toBe('sie');
            expect(resolveAddressing(schedule(), project()).formality).toBe('du');
        });

        await it('wählt die Sie-Vorlage, wenn nur das Projekt Sie festlegt', () => {
            const out = buildHeaderWithWarnings(
                schedule(),
                DEFAULTS,
                project({ greeting: 'Frau Muster', formality: 'sie' }),
            );
            expect(out?.text.startsWith('Guten Tag Frau Muster,')).toBe(true);
            expect(out?.text.includes('Mit freundlichen Grüßen')).toBe(true);
        });

        await it('erbt Sie vom Vertrag, wenn das Projekt nur die Anrede setzt', () => {
            const inv = schedule({ customer: { name: 'Beispiel GmbH', formality: 'sie' } });
            const out = buildHeaderWithWarnings(inv, DEFAULTS, project({ greeting: 'Frau Muster' }));
            expect(out?.text.startsWith('Guten Tag Frau Muster,')).toBe(true);
        });
    });

    await describe('Alt-Config ohne Projekte', async () => {
        await it('rendert exakt wie vor den Projekten', () => {
            const inv = schedule({ customer: { name: 'Beispiel GmbH', greeting: 'Silke', closing: 'Herzlich' } });
            const without = buildHeaderWithWarnings(inv, DEFAULTS);
            const withEmpty = buildHeaderWithWarnings(inv, DEFAULTS, undefined);
            expect(without).toStrictEqual(withEmpty);
            expect(without?.text.startsWith('Hallo Silke,')).toBe(true);
            expect(without?.text.includes('Herzlich')).toBe(true);
            expect(without?.warnings).toStrictEqual([]);
        });

        await it('warnt wie bisher, wenn der Vertrag keine Anrede hat', () => {
            expect(buildHeaderWithWarnings(schedule(), DEFAULTS)?.warnings).toStrictEqual([GREETING_MISSING]);
        });
    });
};
