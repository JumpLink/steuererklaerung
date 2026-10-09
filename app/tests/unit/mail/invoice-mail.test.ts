import { describe, it, expect } from '@gjsify/unit';
import { eur } from '../../../src/core/lib/format.ts';
import {
    buildInvoiceMail,
    missingMailValues,
    MAIL_PLACEHOLDERS,
    OPTIONAL_PLACEHOLDERS,
    REQUIRED_PLACEHOLDERS,
    renderMailTemplate,
    salutation,
    unknownMailPlaceholders,
} from '../../../src/core/mail/invoice-mail.ts';

const ctx = {
    number: 'RE-0042',
    total: 119,
    dueDate: '2026-03-15',
    issuerName: 'Muster Studio',
};

export default async () => {
    await describe('invoice mail template', async () => {
        await it('addresses a du customer by the greeting name', async () => {
            expect(salutation('du', 'Silke')).toBe('Hallo Silke,');
            expect(salutation(undefined, '  Silke ')).toBe('Hallo Silke,');
        });

        await it('addresses a Sie customer formally, with or without a name', async () => {
            expect(salutation('sie', 'Frau Muster')).toBe('Guten Tag Frau Muster,');
            expect(salutation('sie', '')).toBe('Guten Tag,');
            expect(salutation('du', '')).toBe('Hallo,');
        });

        await it('fills number, amount, due date and sign-off', async () => {
            const mail = buildInvoiceMail({ ...ctx, greeting: 'Silke', formality: 'du' });
            expect(mail.subject).toBe('Rechnung RE-0042');
            expect(mail.text).toContain('Hallo Silke,');
            expect(mail.text).toContain('Rechnung RE-0042');
            expect(mail.text).toContain('15.03.2026');
            expect(mail.text).toContain('Beste Grüße');
            expect(mail.text).toContain('Muster Studio');
        });

        await it('uses the formal text and sign-off for Sie', async () => {
            const mail = buildInvoiceMail({ ...ctx, formality: 'sie' });
            expect(mail.text.startsWith('Guten Tag,')).toBe(true);
            expect(mail.text.includes('Sehr geehrte')).toBe(false);
            expect(mail.text).toContain('erhalten Sie');
            expect(mail.text).toContain('Mit freundlichen Grüßen');
        });

        await it('drops the due-date clause instead of leaving it dangling', async () => {
            const mail = buildInvoiceMail({ ...ctx, dueDate: null });
            expect(mail.text).not.toContain('fällig');
            expect(mail.text).toContain('über');
            expect(mail.text.includes('{')).toBe(false);
        });

        await it('offers the payment link on its own line', async () => {
            const url = 'https://pay.qonto.com/invoices/00000000-0000-0000-0000-000000000000';
            const mail = buildInvoiceMail({ ...ctx, paymentUrl: url });
            expect(mail.text).toContain(`Online ansehen und bezahlen: ${url}`);
            const sie = buildInvoiceMail({ ...ctx, formality: 'sie', paymentUrl: url });
            expect(sie.text).toContain(`Online ansehen und bezahlen: ${url}`);
        });

        await it('drops the whole payment-link line without a link, leaving no blank-line rest', async () => {
            for (const paymentUrl of [undefined, null, '  ']) {
                const mail = buildInvoiceMail({ ...ctx, greeting: 'Silke', paymentUrl });
                expect(mail.text.includes('bezahlen')).toBe(false);
                expect(mail.text.includes('\n\n\n')).toBe(false);
                expect(mail.text).toBe(
                    `Hallo Silke,\n\nanbei die Rechnung RE-0042 über ${eur(119)}, fällig am 15.03.2026.\n\nBeste Grüße\nMuster Studio`,
                );
            }
        });

        await it('lets an edited template place {zahlungslink} itself', async () => {
            const url = 'https://pay.qonto.com/invoices/abc';
            expect(renderMailTemplate('Link: {zahlungslink}', { ...ctx, paymentUrl: url })).toBe(`Link: ${url}`);
            expect(renderMailTemplate('Hallo\n\nLink: {zahlungslink}\n\nTschüss', ctx)).toBe('Hallo\n\nTschüss');
        });

        await it('keeps a misspelled placeholder as typed and reports it for the send warning', async () => {
            expect(renderMailTemplate('Betrag {betrg}', ctx)).toBe('Betrag {betrg}');
            expect(unknownMailPlaceholders('Betrag {betrg} {betrag} {nummer}')).toStrictEqual(['betrg']);
            const mail = buildInvoiceMail(ctx, {
                id: 't',
                name: 'T',
                subject: 'Re {rechnungsnr}',
                body: 'Hallo {kunde}',
            });
            expect(mail.unknown).toStrictEqual(['rechnungsnr']);
        });

        await it('fills the extended placeholder set and drops lines without a value', async () => {
            const full = {
                ...ctx,
                net: 100,
                issueDate: '2026-03-01',
                period: { start: '2026-01-01', end: '2026-12-31' },
                customerName: 'Demo Kunde',
                itemTitles: ['Hosting', 'Domain'],
                domains: ['example.invalid'],
                projectName: 'Relaunch',
            };
            const tpl =
                'Kunde {kunde}\nNetto {netto}\nDatum {datum}\nZeitraum {leistungszeitraum}\nPos {positionen}\nDomain {domain}\nProjekt {projekt}';
            const out = renderMailTemplate(tpl, full);
            expect(out).toContain('Kunde Demo Kunde');
            expect(out).toContain('Zeitraum 01.01.2026 – 31.12.2026');
            expect(out).toContain('Pos Hosting und Domain');
            expect(out).toContain('Projekt Relaunch');
            const bare = renderMailTemplate(tpl, ctx);
            expect(bare.includes('Projekt')).toBe(false);
            expect(bare.includes('{')).toBe(false);
        });

        await it('picks the Sie text of a named template and falls back to du when unset', async () => {
            const t = {
                id: 'h',
                name: 'Hosting',
                subject: 'Du {rechnungsnummer}',
                body: 'Du-Text',
                bodySie: 'Sie-Text',
            };
            expect(buildInvoiceMail({ ...ctx, formality: 'sie' }, t).text).toBe('Sie-Text');
            expect(buildInvoiceMail({ ...ctx, formality: 'sie' }, t).subject).toBe('Du RE-0042');
            expect(buildInvoiceMail(ctx, t).text).toBe('Du-Text');
        });

        await it('drops lines of optional placeholders but keeps the core sentence when a required value is empty', async () => {
            const tpl =
                'Projekt: {projekt}\nZeitraum: {leistungszeitraum}\nanbei die Rechnung {rechnungsnummer} über {betrag}.';
            const out = renderMailTemplate(tpl, { ...ctx, total: null });
            expect(out.includes('Projekt')).toBe(false);
            expect(out.includes('Zeitraum')).toBe(false);
            expect(out).toBe('anbei die Rechnung RE-0042 über .');
            const noNumber = renderMailTemplate('Rechnung {rechnungsnummer} für {kunde}', { ...ctx, number: '' });
            expect(noNumber).toBe('Rechnung für');
        });

        await it('reports empty required values as missing, but not empty optional ones', async () => {
            const tpl = 'x {betrag} {kunde} {projekt} {rechnungsnummer}';
            const missing = missingMailValues(tpl, { ...ctx, total: null });
            expect(missing.includes('betrag')).toBe(true);
            expect(missing.includes('kunde')).toBe(true);
            expect(missing.includes('projekt' as never)).toBe(false);
            expect(missing.includes('rechnungsnummer')).toBe(false);
            expect(
                buildInvoiceMail({ ...ctx, total: null }, { id: 't', name: 'T', subject: 'S', body: 'über {betrag}' })
                    .missing[0],
            ).toBe('betrag');
        });

        await it('classifies every placeholder as optional, required or the special due date', async () => {
            const all = Object.keys(MAIL_PLACEHOLDERS).sort();
            const classified = [...OPTIONAL_PLACEHOLDERS, ...REQUIRED_PLACEHOLDERS, 'faelligkeit'].sort();
            expect(classified).toStrictEqual(all);
        });

        await it('renders a manifest without mailTemplates exactly as before (subject and text, du/sie, with/without link)', async () => {
            const url = 'https://pay.qonto.com/invoices/abc';
            const base = { ...ctx, greeting: 'Silke' };
            const amount = eur(119);
            const duNoLink = buildInvoiceMail(base);
            expect(duNoLink.subject).toBe('Rechnung RE-0042');
            expect(duNoLink.text).toBe(
                `Hallo Silke,\n\nanbei die Rechnung RE-0042 über ${amount}, fällig am 15.03.2026.\n\nBeste Grüße\nMuster Studio`,
            );
            const duLink = buildInvoiceMail({ ...base, paymentUrl: url });
            expect(duLink.text).toBe(
                `Hallo Silke,\n\nanbei die Rechnung RE-0042 über ${amount}, fällig am 15.03.2026.\n\nOnline ansehen und bezahlen: ${url}\n\nBeste Grüße\nMuster Studio`,
            );
            const sieNoLink = buildInvoiceMail({ ...ctx, formality: 'sie' });
            expect(sieNoLink.subject).toBe('Rechnung RE-0042');
            expect(sieNoLink.text).toBe(
                `Guten Tag,\n\nanbei erhalten Sie die Rechnung RE-0042 über ${amount}, fällig am 15.03.2026.\n\nMit freundlichen Grüßen\nMuster Studio`,
            );
            const sieLink = buildInvoiceMail({ ...ctx, formality: 'sie', greeting: 'Frau Muster', paymentUrl: url });
            expect(sieLink.text).toBe(
                `Guten Tag Frau Muster,\n\nanbei erhalten Sie die Rechnung RE-0042 über ${amount}, fällig am 15.03.2026.\n\nOnline ansehen und bezahlen: ${url}\n\nMit freundlichen Grüßen\nMuster Studio`,
            );
            const noDue = buildInvoiceMail({ ...base, dueDate: null });
            expect(noDue.text).toBe(
                `Hallo Silke,\n\nanbei die Rechnung RE-0042 über ${amount}.\n\nBeste Grüße\nMuster Studio`,
            );
        });
    });
};
