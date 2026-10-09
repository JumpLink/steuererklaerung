import { describe, it, expect } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { recurringEmail } from '../../../src/core/actions/recurring-invoices.ts';
import { draftInvoiceMail, loadInvoiceMailSetup } from '../../../src/core/actions/send-invoice-email.ts';
import { eur } from '../../../src/core/lib/format.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const url = 'https://pay.qonto.com/invoices/00000000-0000-0000-0000-000000000000';

const schedule = (over: Record<string, unknown> = {}) => ({
    id: 'demo-hosting',
    customer: { name: 'Demo Kunde', email: 'kunde@example.invalid', contactId: 'c_demo' },
    nextPeriod: { start: '2027-07-08', end: '2028-07-07' },
    items: [{ title: 'Hosting', quantity: 1, unitPrice: 100, vatRate: 19 }],
    lastInvoice: {
        number: 'RE-0001',
        issueDate: '2026-07-08',
        period: { start: '2026-07-08', end: '2027-07-07' },
        providerId: 'inv-1',
        url,
    },
    ...over,
});

const project = {
    id: 'demo-site',
    name: 'Demo Site',
    contactId: 'c_demo',
    contactPerson: { greeting: 'Silke', formality: 'du' },
};

export default async () => {
    await describe('recurring email preview', async () => {
        const dirs: string[] = [];
        const fixture = (recurring: unknown[], projects: unknown[] = [], invoicing: Record<string, unknown> = {}) => {
            const made = writeManifestFixture({
                entities: [
                    {
                        id: 'demo',
                        name: 'Demo Studio',
                        invoicing: { type: 'qonto', paymentTermsDays: 14, defaultClosing: 'Beste Grüße', ...invoicing },
                        projects,
                        recurring,
                    },
                ],
            });
            dirs.push(made.dir);
            return made.path;
        };
        const cleanup = () => {
            for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
        };

        await it('is about the last issued invoice, not the following period', async () => {
            const path = fixture([schedule()]);
            const mail = recurringEmail('demo-hosting', path);
            expect(mail.invoice.number).toBe('RE-0001');
            expect(mail.invoice.period).toStrictEqual({ start: '2026-07-08', end: '2027-07-07' });
            expect(mail.subject).toBe('Rechnung RE-0001');
            expect(mail.body).toContain('fällig am 22.07.2026');
            expect(mail.body).toContain(eur(119));
            expect(mail.body).toContain(`Online ansehen und bezahlen: ${url}`);
            expect(mail.to).toBe('kunde@example.invalid');
            cleanup();
        });

        await it('takes the salutation from the project before the contract', async () => {
            const path = fixture(
                [
                    schedule({
                        projectId: 'demo-site',
                        customer: { name: 'Demo Kunde', contactId: 'c_demo', greeting: 'Vertrag', formality: 'sie' },
                    }),
                ],
                [project],
            );
            const mail = recurringEmail('demo-hosting', path);
            expect(mail.body.startsWith('Hallo Silke,')).toBe(true);
            expect(mail.body.includes('erhalten Sie')).toBe(false);
            cleanup();
        });

        await it('uses Sie from the contract and a nameless "Guten Tag," when nothing names a person', async () => {
            const path = fixture([schedule({ customer: { name: 'Demo Kunde', formality: 'sie' } })]);
            const mail = recurringEmail('demo-hosting', path);
            expect(mail.body.startsWith('Guten Tag,')).toBe(true);
            expect(mail.body).toContain('erhalten Sie');
            cleanup();
        });

        await it('says so when nothing was issued yet', async () => {
            const path = fixture([schedule({ lastInvoice: undefined })]);
            let message = '';
            try {
                recurringEmail('demo-hosting', path);
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message).toContain('noch keine ausgestellte Rechnung');
            cleanup();
        });

        await it('drafts the same text as the dialog path for the same invoice', async () => {
            const path = fixture([schedule()], [project]);
            const setup = loadInvoiceMailSetup(
                'demo',
                { invoiceId: 'inv-1', invoiceNumber: 'RE-0001' },
                null,
                'Demo Studio',
                path,
            );
            const dialog = draftInvoiceMail(setup, { number: 'RE-0001', total: 119, dueDate: '2026-07-22', url });
            expect(recurringEmail('demo-hosting', path).body).toBe(dialog.text);
            cleanup();
        });

        await it('uses the named template: contract wins over project and entity default, Sie variant works', async () => {
            const templates = [
                {
                    id: 'hosting',
                    name: 'Hosting',
                    subject: 'Hosting {rechnungsnummer}',
                    body: 'Zeitraum {leistungszeitraum}\nProjekt {projekt}',
                    bodySie: 'Sie: {kunde}',
                },
                { id: 'dienst', name: 'Dienstleistung', subject: 'Dienst {netto}', body: 'Pos {positionen}' },
            ];
            const path = fixture(
                [schedule({ mailTemplateId: 'dienst', projectId: 'demo-site' })],
                [{ ...project, mailTemplateId: 'hosting' }],
                { mailTemplates: templates, defaultMailTemplate: 'hosting' },
            );
            const own = recurringEmail('demo-hosting', path);
            expect(own.templateId).toBe('dienst');
            expect(own.subject).toBe(`Dienst ${eur(100)}`);
            expect(own.body).toBe('Pos Hosting');
            const forced = recurringEmail('demo-hosting', path, 'hosting');
            expect(forced.body).toBe('Zeitraum 08.07.2026 – 07.07.2027\nProjekt Demo Site');
            cleanup();
            const sie = fixture([schedule({ customer: { name: 'Demo Kunde', formality: 'sie' } })], [], {
                mailTemplates: templates,
                defaultMailTemplate: 'hosting',
            });
            expect(recurringEmail('demo-hosting', sie).body).toBe('Sie: Demo Kunde');
            cleanup();
        });

        await it('lists unknown placeholders of a template', async () => {
            const path = fixture([schedule()], [], {
                mailTemplates: [{ id: 'x', name: 'X', subject: 'S {oops}', body: 'B' }],
                defaultMailTemplate: 'x',
            });
            expect(recurringEmail('demo-hosting', path).unknownPlaceholders[0]).toBe('oops');
            cleanup();
        });

        await it('only offers an https link to the customer', async () => {
            const setup = loadInvoiceMailSetup(
                'demo',
                { invoiceId: 'x', invoiceNumber: null },
                null,
                'Demo Studio',
                fixture([]),
            );
            for (const bad of ['http://pay.example.invalid/x', 'javascript:alert(1)', null]) {
                const draft = draftInvoiceMail(setup, { number: 'RE-1', total: 1, dueDate: null, url: bad });
                expect(draft.text.includes('bezahlen')).toBe(false);
            }
            cleanup();
        });
    });
};
