/**
 * Verträge, ADR 0004 step 5 — the extraction's checkable halves, without a model and without a
 * document store: what the schema accepts, what the diff makes of an answer, what an accepted field
 * becomes, and that a free hosted model is refused BEFORE a contract ever reaches it.
 *
 * All data here is invented. A contract names the counterparty, the account it is paid from and
 * often an IBAN, so no real document or figure may appear in a test.
 */
import { describe, it, expect } from '@gjsify/unit';

import type { DmsProvider } from '@steuererklaerung/dms';
import type { ContractRecord } from '@steuererklaerung/store';

import { AiJobError } from '../../../src/core/clients/llm/index.ts';
import {
    buildContractProposal,
    changedFields,
    CONTRACT_PROPOSAL_FIELDS,
    ContractReadingSchema,
    contractInputFromProposal,
    providerDocumentId,
    SNIPPET_MAX_CHARS,
    type ContractProposal,
} from '../../../src/core/actions/contracts-extract.ts';
import { fakeAgentProvider } from '../../helpers/fake-opencode-agent.ts';

const read = (value: unknown, confidence = 0.9, snippet = 'steht so im Dokument') => ({
    value,
    confidence,
    snippet,
});

/** A contract as the ledger holds it — invented values, no real counterparty. */
const contract = (over: Partial<ContractRecord> = {}): ContractRecord =>
    ({
        id: 'c-1',
        entityId: 'privat',
        name: 'Beispiel-Tarif',
        counterparty: 'Beispiel Versorger AG',
        counterpartyRef: null,
        contractNumber: 'ALT-1',
        accountKey: null,
        category: null,
        amount: 10,
        cycle: 'monatlich',
        amountTolerance: null,
        startDate: '2024-01-01',
        initialTermMonths: 12,
        renewalMonths: null,
        noticeValue: null,
        noticeUnit: null,
        autoRenewal: false,
        endDate: null,
        paymentMethod: null,
        creditorId: null,
        mandateReference: null,
        counterpartyIban: null,
        matchText: null,
        status: 'active',
        notes: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        ...over,
    }) as ContractRecord;

const dms = (kind: DmsProvider['kind']) => ({ kind }) as DmsProvider;

const fails = (run: () => unknown): string => {
    try {
        run();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected a failure');
};

export default async () => {
    await describe('Vertrag aus Dokument — die Antwort des Modells', async () => {
        await it('reads a full answer and keeps value, confidence and passage', async () => {
            const parsed = ContractReadingSchema.parse({
                counterparty: read('Beispiel Versorger AG'),
                contract_number: read('V-2026-0815'),
                start_date: read('2026-04-01'),
                initial_term_months: read(24),
                renewal_months: read(12),
                notice_value: read(3),
                notice_unit: read('months'),
                auto_renewal: read(true),
                amount: read(19.9),
                cycle: read('monatlich'),
            });
            expect(parsed.counterparty?.value).toBe('Beispiel Versorger AG');
            expect(parsed.notice_unit?.value).toBe('months');
            expect(parsed.auto_renewal?.value).toBe(true);
            expect(parsed.amount?.confidence).toBe(0.9);
            expect(parsed.cycle?.snippet).toBe('steht so im Dokument');
        });

        await it('treats an omitted, empty and null field alike: not stated', async () => {
            const parsed = ContractReadingSchema.parse({
                counterparty: read('Beispiel Versorger AG'),
                contract_number: '',
                start_date: null,
            });
            expect(parsed.contract_number).toBe(undefined);
            expect(parsed.start_date).toBe(undefined);
            expect(parsed.notice_value).toBe(undefined);
        });

        await it('cuts an over-long passage to the kept length', async () => {
            const parsed = ContractReadingSchema.parse({
                counterparty: read('Beispiel Versorger AG', 0.5, 'x'.repeat(SNIPPET_MAX_CHARS + 50)),
            });
            expect(parsed.counterparty?.snippet.length).toBe(SNIPPET_MAX_CHARS);
        });

        await it('fails the whole answer on a wrong-typed value instead of dropping the field', async () => {
            fails(() =>
                ContractReadingSchema.parse({
                    counterparty: read('Beispiel Versorger AG'),
                    notice_value: read('drei Monate'),
                }),
            );
        });

        await it('refuses a value nobody can point at in the document', async () => {
            fails(() => ContractReadingSchema.parse({ amount: { value: 19.9, confidence: 0.9 } }));
            fails(() => ContractReadingSchema.parse({ amount: read(19.9, 0.9, '   ') }));
        });

        await it('refuses a confidence outside 0…1, a non-ISO date and an unknown unit', async () => {
            fails(() => ContractReadingSchema.parse({ amount: read(19.9, 1.5) }));
            fails(() => ContractReadingSchema.parse({ start_date: read('01.04.2026') }));
            fails(() => ContractReadingSchema.parse({ notice_unit: read('Monate') }));
            fails(() => ContractReadingSchema.parse({ cycle: read('monthly') }));
        });
    });

    await describe('Vertrag aus Dokument — der Vorschlag', async () => {
        const reading = ContractReadingSchema.parse({
            notice_unit: read('months'),
            counterparty: read('Beispiel Versorger AG'),
            amount: read(19.9),
            notice_value: read(3),
            initial_term_months: read(12),
        });

        await it('offers only the stated fields, in the order a frontend shows them', async () => {
            const proposal = buildContractProposal(reading, { contractId: 'c-1', documentRef: 'paperless:7' });
            const order = CONTRACT_PROPOSAL_FIELDS.filter((f) => proposal.fields.some((s) => s.field === f));
            expect(proposal.fields.map((f) => f.field).join(',')).toBe(order.join(','));
            expect(proposal.fields.map((f) => f.field).join(',')).toBe(
                'counterparty,amount,initialTermMonths,noticeValue,noticeUnit',
            );
        });

        await it('marks against the contract what would really change', async () => {
            const proposal = buildContractProposal(reading, {
                contractId: 'c-1',
                documentRef: 'paperless:7',
                current: contract(),
                model: 'anthropic/claude-sonnet-5-5',
            });
            const by = new Map(proposal.fields.map((f) => [f.field, f]));
            // Same as the ledger already has → nothing to accept.
            expect(by.get('counterparty')?.differs).toBe(false);
            expect(by.get('initialTermMonths')?.differs).toBe(false);
            // Different, and the empty notice fields the contract never had.
            expect(by.get('amount')?.current).toBe(10);
            expect(by.get('amount')?.differs).toBe(true);
            expect(by.get('noticeValue')?.current).toBe(null);
            expect(changedFields(proposal).join(',')).toBe('amount,noticeValue,noticeUnit');
            expect(proposal.model).toBe('anthropic/claude-sonnet-5-5');
        });

        await it('while creating a contract there is nothing to compare against', async () => {
            const proposal = buildContractProposal(reading, { contractId: null, documentRef: '12' });
            expect(proposal.fields.every((f) => f.current === undefined)).toBe(true);
            expect(changedFields(proposal).length).toBe(proposal.fields.length);
            expect(proposal.hints.length).toBe(0);
        });

        await it('says so when the document states none of the fields', async () => {
            const proposal = buildContractProposal(ContractReadingSchema.parse({}), {
                contractId: 'c-1',
                documentRef: 'paperless:7',
                current: contract(),
            });
            expect(proposal.fields.length).toBe(0);
            expect(proposal.hints.length).toBe(1);
            expect(changedFields(proposal).length).toBe(0);
        });

        await it('writes only the fields a person ticked, and keeps the contract id', async () => {
            const proposal = buildContractProposal(reading, {
                contractId: 'c-1',
                documentRef: 'paperless:7',
                current: contract(),
            });
            const input = contractInputFromProposal(proposal, ['amount', 'noticeValue', 'noticeUnit']);
            expect(input.id).toBe('c-1');
            expect(input.amount).toBe(19.9);
            expect(input.noticeValue).toBe(3);
            expect(input.noticeUnit).toBe('months');
            // Not ticked → absent, so `saveContract` leaves it alone.
            expect('counterparty' in input).toBe(false);
            expect('initialTermMonths' in input).toBe(false);
        });

        await it('accepting nothing writes nothing; a field the document never stated is not cleared', async () => {
            const proposal = buildContractProposal(reading, { contractId: null, documentRef: '12' });
            expect(Object.keys(contractInputFromProposal(proposal, [])).length).toBe(0);
            const input = contractInputFromProposal(proposal, ['startDate', 'autoRenewal']);
            expect(Object.keys(input).length).toBe(0);
        });
    });

    await describe('Vertrag aus Dokument — welches Dokument gemeint ist', async () => {
        await it('passes a bare id through and strips the prefix of its own store', async () => {
            expect(providerDocumentId(dms('paperless'), '12')).toBe('12');
            expect(providerDocumentId(dms('paperless'), 'paperless:12')).toBe('12');
            expect(providerDocumentId(dms('builtin'), ' builtin:doc-1 ')).toBe('doc-1');
        });

        await it('refuses a ref from the other document store and an empty one', async () => {
            // Both fail, and they say different things — the messages are translated, so the test
            // checks that they are distinguishable rather than matching one language's wording.
            const other = fails(() => providerDocumentId(dms('paperless'), 'builtin:doc-1'));
            const empty = fails(() => providerDocumentId(dms('builtin'), '   '));
            expect(other.length > 0).toBe(true);
            expect(other === empty).toBe(false);
        });
    });

    await describe('Vertrag aus Dokument — kein Gratis-Modell', async () => {
        // The guarantee the module header makes, run: the policy is lotse's, checked in `runJob`
        // before the prompt leaves this machine. The fake agent answers a perfectly valid reading —
        // it must still never be asked.
        const answer = JSON.stringify({ counterparty: read('Beispiel Versorger AG') });

        const denied = async (provider: ReturnType<typeof fakeAgentProvider>): Promise<AiJobError> => {
            try {
                await provider.completeJson({ system: 's', user: 'u', schema: ContractReadingSchema });
            } catch (error) {
                if (error instanceof AiJobError) return error;
                throw error;
            }
            throw new Error('the contract data was sent to a denied model');
        };

        await it('a free hosted model asked for explicitly is refused', async () => {
            const error = await denied(
                fakeAgentProvider({ answer, models: ['opencode/fledge-alpha-free'] }, 'opencode/fledge-alpha-free'),
            );
            expect(error.kind).toBe('denied');
        });

        await it('a free hosted model the agent happens to have selected is refused', async () => {
            const error = await denied(
                fakeAgentProvider({ answer, models: ['opencode/fledge-alpha-free', 'anthropic/claude-sonnet-5-5'] }),
            );
            expect(error.kind).toBe('denied');
        });

        await it('an agent that names no model at all is refused: nobody can say where this would go', async () => {
            const error = await denied(fakeAgentProvider({ answer, noModelOption: true }));
            expect(error.kind).toBe('unknown-model');
        });

        await it('the known limit, run rather than implied: an unlisted model is allowed', async () => {
            // `denyFreeHostedModels` catches lotse's maintained free ids and the `-free` suffix. An
            // id it has never heard of is ALLOWED on purpose (lotse's model-policy.ts: denying
            // everything unknown denies ~400 paid models and leaves no model to pick). So a free
            // model shipped without either marker is not caught here — the gate is the person's
            // model choice, and an allowlist policy is what a stricter host would pass instead.
            const result = await fakeAgentProvider({ answer, models: ['irgendwas/unbekannt'] }).completeJson({
                system: 's',
                user: 'u',
                schema: ContractReadingSchema,
            });
            expect(result.model).toBe('irgendwas/unbekannt');
        });

        await it('a paid model answers, so the refusals above are the policy and not a broken fake', async () => {
            const result = await fakeAgentProvider({ answer }).completeJson({
                system: 's',
                user: 'u',
                schema: ContractReadingSchema,
            });
            expect(result.value.counterparty?.value).toBe('Beispiel Versorger AG');
            const proposal: ContractProposal = buildContractProposal(result.value, {
                contractId: null,
                documentRef: '12',
                ...(result.model ? { model: result.model } : {}),
            });
            expect(proposal.fields.length).toBe(1);
        });
    });
};
