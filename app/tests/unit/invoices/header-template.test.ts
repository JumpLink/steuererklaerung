import { describe, expect, it } from '@gjsify/unit';
import type { RecurringInvoice } from '../../../src/core/config/index.ts';
import {
    buildHeader,
    buildHeaderWithWarnings,
    DEFAULT_CLOSING,
    DEFAULT_CLOSING_SIE,
    DEFAULT_HEADER_TEMPLATE,
    DEFAULT_HEADER_TEMPLATE_SIE,
    GREETING_MISSING,
    HEADER_PLACEHOLDERS,
    joinGerman,
    pickHeaderTemplate,
    renderHeader,
    renderHeaderWithWarnings,
    unknownPlaceholders,
    type HeaderContext,
} from '../../../src/core/invoices/header-template.ts';

function ctx(over: Partial<HeaderContext> = {}): HeaderContext {
    return {
        customerName: 'Musterkunde GmbH',
        domains: ['example.com'],
        period: { start: '2026-01-01', end: '2026-12-31' },
        itemTitles: ['Website Hosting | Basic'],
        issuerName: 'Muster Einzelunternehmen',
        ...over,
    };
}

function schedule(over: Partial<RecurringInvoice> = {}): RecurringInvoice {
    return {
        id: 'musterkunde-example-com',
        entityId: 'muster',
        status: 'active',
        customer: { name: 'Musterkunde GmbH' },
        description: 'Website Hosting example.com',
        domains: ['example.com'],
        intervalMonths: 12,
        nextPeriod: { start: '2026-01-01', end: '2026-12-31' },
        reminderLeadDays: 28,
        currency: 'EUR',
        items: [{ title: 'Website Hosting | Basic', quantity: 1, unitPrice: 108, vatRate: 19 }],
        ...over,
    };
}

export default async () => {
    await describe('Anschreiben-Template (renderHeader)', async () => {
        await it('ersetzt jeden Platzhalter', () => {
            const out = renderHeader(
                '{anrede}|{kunde}|{domain}|{periode}|{vorperiode}|{paket}|{gruss}|{aussteller}',
                ctx({
                    greeting: 'Silke',
                    closing: 'Herzliche Grüße',
                    previousPeriod: { start: '2025-01-01', end: '2025-12-31' },
                }),
            );
            expect(out).toBe(
                'Silke|Musterkunde GmbH|example.com|01.01.2026 – 31.12.2026|01.01.2025 – 31.12.2025|Website Hosting | Basic|Herzliche Grüße|Muster Einzelunternehmen',
            );
        });

        await it('rendert den Standardtext zu einem vollständigen Anschreiben', () => {
            const out = renderHeader(DEFAULT_HEADER_TEMPLATE, ctx({ greeting: 'Silke' }));
            expect(out.startsWith('Hallo Silke,\n\nanbei die Rechnung für das Hosting example.com')).toBe(true);
            expect(out.includes('Serviceperiode 01.01.2026 – 31.12.2026.')).toBe(true);
            expect(out.endsWith(`${DEFAULT_CLOSING}\nMuster Einzelunternehmen`)).toBe(true);
        });

        await it('erlaubt freie Anrede wie „Markus, moin Frederik"', () => {
            expect(renderHeader('Hallo {anrede},', ctx({ greeting: 'Markus, moin Frederik' }))).toBe(
                'Hallo Markus, moin Frederik,',
            );
        });

        await it('ignoriert Groß-/Kleinschreibung und Leerraum im Platzhalternamen', () => {
            expect(renderHeader('{ Kunde }/{KUNDE}', ctx())).toBe('Musterkunde GmbH/Musterkunde GmbH');
        });

        await it('wirft bei unbekanntem Platzhalter und nennt ihn samt den erlaubten', () => {
            let message = '';
            try {
                renderHeader('Hallo {anrede}, {domian} {foo}', ctx());
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('{domian}')).toBe(true);
            expect(message.includes('{foo}')).toBe(true);
            expect(message.includes('{anrede}')).toBe(true); // Liste der erlaubten
        });

        await it('unknownPlaceholders findet nur die unbekannten, einmal je Name', () => {
            expect(unknownPlaceholders('{kunde} {x} {x} {y}').join(',')).toBe('x,y');
            expect(unknownPlaceholders('kein Platzhalter').length).toBe(0);
        });

        await it('dokumentiert jeden Platzhalter', () => {
            for (const key of Object.keys(HEADER_PLACEHOLDERS)) {
                expect(renderHeader(`{${key}}`, ctx()).length >= 0).toBe(true);
            }
        });
    });

    await describe('Anschreiben: fehlende Werte hinterlassen keine kaputten Sätze', async () => {
        await it('{anrede} bleibt ohne Anrede leer — der Kundenname ist kein Fallback', () => {
            expect(renderHeader('Anrede=[{anrede}] Kunde=[{kunde}]', ctx())).toBe('Anrede=[] Kunde=[Musterkunde GmbH]');
        });

        await it('{domain}: mehrere Domains werden deutsch verbunden', () => {
            expect(renderHeader('{domain}', ctx({ domains: ['a.example.com', 'b.example.com'] }))).toBe(
                'a.example.com und b.example.com',
            );
            expect(
                renderHeader('{domain}', ctx({ domains: ['a.example.com', 'b.example.com', 'c.example.com'] })),
            ).toBe('a.example.com, b.example.com und c.example.com');
        });

        await it('{domain} ohne Domains: Bezeichnung, sonst Kundenname', () => {
            expect(renderHeader('{domain}', ctx({ domains: [], description: 'Website Hosting' }))).toBe(
                'Website Hosting',
            );
            expect(renderHeader('{domain}', ctx({ domains: [] }))).toBe('Musterkunde GmbH');
        });

        await it('{vorperiode} ist ohne frühere Rechnung leer', () => {
            expect(renderHeader('Vorher: [{vorperiode}]', ctx())).toBe('Vorher: []');
        });

        await it('{gruss} fällt auf die Standard-Grußformel zurück', () => {
            expect(renderHeader('{gruss}', ctx())).toBe(DEFAULT_CLOSING);
            expect(renderHeader('{gruss}', ctx({ closing: '' }))).toBe(DEFAULT_CLOSING);
        });

        await it('{paket} verbindet mehrere Positionen', () => {
            expect(renderHeader('{paket}', ctx({ itemTitles: ['Hosting', 'Domain', 'Backup'] }))).toBe(
                'Hosting, Domain und Backup',
            );
        });

        await it('ohne Aussteller bleibt keine leere Signaturzeile stehen', () => {
            const out = renderHeader('Hallo,\n\n{gruss}\n{aussteller}\n', ctx({ issuerName: undefined }));
            expect(out).toBe(`Hallo,\n\n${DEFAULT_CLOSING}`);
        });
    });

    await describe('Anschreiben: Rangfolge Schedule > Entität > keins', async () => {
        const entity = { defaultHeader: 'Entität {kunde}', defaultClosing: 'Viele Grüße', issuerName: 'Aussteller' };

        await it('der Header des Schedules gewinnt', () => {
            expect(buildHeader(schedule({ header: 'Schedule {kunde}' }), entity)).toBe('Schedule Musterkunde GmbH');
        });

        await it('ohne Schedule-Header gilt der Entitäts-Standard', () => {
            expect(buildHeader(schedule(), entity)).toBe('Entität Musterkunde GmbH');
            expect(buildHeader(schedule({ header: '  ' }), entity)).toBe('Entität Musterkunde GmbH');
        });

        await it('ohne beides gibt es keinen Header', () => {
            expect(buildHeader(schedule(), {})).toBe(undefined);
            expect(pickHeaderTemplate(schedule(), { defaultHeader: null })).toBe(undefined);
        });

        await it('Grußformel: Kunde > Entität > Standard', () => {
            const t = { header: '{gruss}' };
            expect(buildHeader(schedule({ ...t, customer: { name: 'K', closing: 'Beste Grüße' } }), entity)).toBe(
                'Beste Grüße',
            );
            expect(buildHeader(schedule(t), entity)).toBe('Viele Grüße');
            expect(buildHeader(schedule(t), {})).toBe(DEFAULT_CLOSING);
        });

        await it('nimmt Zeitraum und Vorperiode aus dem Schedule', () => {
            const out = buildHeader(
                schedule({
                    header: '{periode} / {vorperiode}',
                    lastInvoice: { issueDate: '2025-01-01', period: { start: '2025-01-01', end: '2025-12-31' } },
                }),
                {},
            );
            expect(out).toBe('01.01.2026 – 31.12.2026 / 01.01.2025 – 31.12.2025');
        });

        await it('ein unbekannter Platzhalter im Schedule-Header wirft beim Bauen', () => {
            let failed = false;
            try {
                buildHeader(schedule({ header: 'Hallo {name}' }), {});
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
        });
    });

    await describe('Anschreiben: leere Anrede', async () => {
        await it('du: „Hallo {anrede}," wird zu „Hallo,"', () => {
            expect(renderHeader('Hallo {anrede},', ctx())).toBe('Hallo,');
            expect(renderHeader('Hallo {anrede},', ctx({ greeting: '   ' }))).toBe('Hallo,');
        });

        await it('sie: „Guten Tag {anrede}," wird zu „Guten Tag,"', () => {
            expect(renderHeader('Guten Tag {anrede},', ctx({ formality: 'sie' }))).toBe('Guten Tag,');
        });

        await it('entfernt auch mehrere Leerzeichen und Tabs vor dem Platzhalter', () => {
            expect(renderHeader('Hallo  \t{ Anrede },', ctx())).toBe('Hallo,');
        });

        await it('mit Anrede bleibt der Satz unverändert', () => {
            expect(renderHeader('Hallo {anrede},', ctx({ greeting: 'Silke' }))).toBe('Hallo Silke,');
            expect(renderHeader('Guten Tag {anrede},', ctx({ greeting: 'Frau Muster', formality: 'sie' }))).toBe(
                'Guten Tag Frau Muster,',
            );
        });

        await it('beide Standardvorlagen ergeben ohne Anrede einen sauberen Satz', () => {
            expect(renderHeader(DEFAULT_HEADER_TEMPLATE, ctx()).startsWith('Hallo,\n\nanbei die Rechnung')).toBe(true);
            expect(
                renderHeader(DEFAULT_HEADER_TEMPLATE_SIE, ctx({ formality: 'sie' })).startsWith(
                    'Guten Tag,\n\nanbei erhalten Sie die Rechnung',
                ),
            ).toBe(true);
        });
    });

    await describe('Anschreiben: Warnungen', async () => {
        await it('fehlende Anrede wird gemeldet, wenn die Vorlage {anrede} nutzt', () => {
            expect(renderHeaderWithWarnings('Hallo {anrede},', ctx()).warnings.join()).toBe(GREETING_MISSING);
            expect(renderHeaderWithWarnings('Hallo {anrede},', ctx({ greeting: ' ' })).warnings.length).toBe(1);
        });

        await it('keine Warnung mit Anrede oder ohne {anrede} in der Vorlage', () => {
            expect(renderHeaderWithWarnings('Hallo {anrede},', ctx({ greeting: 'Silke' })).warnings.length).toBe(0);
            expect(renderHeaderWithWarnings('Hallo,', ctx()).warnings.length).toBe(0);
        });

        await it('buildHeaderWithWarnings reicht die Warnung durch; ohne Vorlage gibt es nichts', () => {
            const entity = { defaultHeader: 'Hallo {anrede},' };
            expect(buildHeaderWithWarnings(schedule(), entity)?.warnings.join()).toBe(GREETING_MISSING);
            expect(buildHeaderWithWarnings(schedule(), {})).toBe(undefined);
        });
    });

    await describe('Anschreiben: Du/Sie', async () => {
        const entity = {
            defaultHeader: 'DU {kunde}',
            defaultClosing: 'Viele Grüße',
            defaultHeaderSie: 'SIE {kunde}',
            defaultClosingSie: 'Freundliche Grüße',
            issuerName: 'Aussteller',
        };
        const sie = (over: Partial<RecurringInvoice> = {}, customer: Record<string, string> = {}) =>
            schedule({ ...over, customer: { name: 'Musterkunde GmbH', formality: 'sie', ...customer } });

        await it('ohne formality gilt du (alte Config)', () => {
            expect(buildHeader(schedule(), entity)).toBe('DU Musterkunde GmbH');
            expect(buildHeader(schedule({ header: '{gruss}' }), {})).toBe(DEFAULT_CLOSING);
            expect(buildHeader(schedule(), { defaultHeader: 'nur du' })).toBe('nur du');
        });

        await it('die Form wählt den Entitäts-Standard', () => {
            expect(buildHeader(schedule({ customer: { name: 'K', formality: 'du' } }), entity)).toBe('DU K');
            expect(buildHeader(sie(), entity)).toBe('SIE Musterkunde GmbH');
        });

        await it('Sie ohne Sie-Standard fällt NICHT auf den Du-Text zurück', () => {
            expect(buildHeader(sie(), { defaultHeader: 'DU' })).toBe(undefined);
        });

        await it('Schedule.header gilt für beide Formen und gewinnt', () => {
            expect(buildHeader(schedule({ header: 'EIGEN {kunde}' }), entity)).toBe('EIGEN Musterkunde GmbH');
            expect(buildHeader(sie({ header: 'EIGEN {kunde}' }), entity)).toBe('EIGEN Musterkunde GmbH');
        });

        await it('Grußformel du: Kunde > Entität > „Beste Grüße"', () => {
            const t = { header: '{gruss}' };
            expect(buildHeader(schedule({ ...t, customer: { name: 'K', closing: 'Ciao' } }), entity)).toBe('Ciao');
            expect(buildHeader(schedule(t), entity)).toBe('Viele Grüße');
            expect(buildHeader(schedule(t), {})).toBe(DEFAULT_CLOSING);
        });

        await it('Grußformel Sie: Kunde > Entität (Sie) > „Mit freundlichen Grüßen"', () => {
            const t = { header: '{gruss}' };
            expect(buildHeader(sie(t, { closing: 'Hochachtungsvoll' }), entity)).toBe('Hochachtungsvoll');
            expect(buildHeader(sie(t), entity)).toBe('Freundliche Grüße');
            expect(buildHeader(sie(t), { defaultClosing: 'Viele Grüße' })).toBe(DEFAULT_CLOSING_SIE);
            expect(DEFAULT_CLOSING_SIE).toBe('Mit freundlichen Grüßen');
        });

        await it('pickHeaderTemplate beachtet die Form', () => {
            expect(pickHeaderTemplate(sie(), entity)).toBe('SIE {kunde}');
            expect(pickHeaderTemplate(schedule(), entity)).toBe('DU {kunde}');
        });
    });

    await describe('joinGerman', async () => {
        await it('verwirft leere Teile', () => {
            expect(joinGerman([])).toBe('');
            expect(joinGerman(['', ' '])).toBe('');
            expect(joinGerman(['a', '', 'b'])).toBe('a und b');
        });
    });
};
