/**
 * Verträge, ADR 0004 step 5 — read a contract's term and payment data off one of its documents and
 * hand it back as a PROPOSAL the person confirms, field by field.
 *
 * **Nothing here writes.** A Kündigungsfrist that is wrong by a month is a contract that renews for
 * another year, so the extraction may not be the thing that decides it. This module reads the
 * document, validates the answer and returns what it read together with the contract's current
 * value and the verbatim passage each value came from; the write stays
 * {@link saveContractRecord}, called by the frontend after a human said yes. Same shape as
 * `suggestZvEFromDocument` in `zve.ts`, for the same reason.
 *
 * **Where the prompt may go.** The job runs through `getLLMProvider()` + `completeJson()`, the one
 * path every one-shot job uses (ADR 0002). With `LLM_PROVIDER=opencode` that is `OpencodeProvider`,
 * which hands {@link LOTSE_MODEL_POLICY} (`denyFreeHostedModels`) to lotse's `runJob`, and `runJob`
 * checks the policy BEFORE the prompt leaves this machine: a free hosted model fails as
 * `JobError('denied')`, a model lotse cannot identify as `'unknown-model'`, and both arrive here as
 * an `AiJobError` of the same kind. A contract document names the counterparty, the account it is
 * paid from and often an IBAN — exactly the data that must not become somebody's free tier.
 *
 * `claude` and `scaleway` carry no policy, deliberately: neither is a model marketplace. Each talks
 * to one vendor on this person's own subscription or API key, so there is no free hosted model to
 * select and nothing for a policy to refuse. If either ever gains a model choice, the policy belongs
 * in that provider next to opencode's — not re-implemented per action.
 *
 * **Strict, not lenient.** Unlike the invoice extraction (`lenientNumber`, where a dropped field is
 * one empty Paperless field among many), a wrongly-typed answer fails the whole job here. The
 * result is shown to a person who confirms it: a clear "the AI answer does not match the expected
 * format" they can retry beats an answer that silently lost half its fields and looks complete.
 */

import { z } from 'zod';

import type { DmsProvider } from '@steuererklaerung/dms';
import {
    CONTRACT_CYCLES,
    type ContractCycle,
    type ContractInput,
    type ContractRecord,
    NOTICE_UNITS,
    type NoticeUnit,
} from '@steuererklaerung/store';

import { completeJson, getLLMProvider } from '../clients/llm/index.ts';
import { isAssistantEnabled } from '../config/assistant-preference.ts';
import { absent } from '../lib/ai-schema.ts';
import { _ } from '../lib/i18n.ts';
import { buildContractExtractionUserPrompt, CONTRACT_EXTRACTION_SYSTEM_PROMPT } from '../lib/prompts.ts';
import { loadContract } from './contracts.ts';
import { getDocumentWithText } from './dms/inbox.ts';
import { resolveEntityDms } from './link-candidates.ts';

/** Longest passage kept per field — enough to recognise the sentence, short of quoting the document. */
export const SNIPPET_MAX_CHARS = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]]);

/**
 * One field as the model answers it: the value, how sure it is, and the passage it read it from.
 * The snippet is required — a value nobody can point at in the document is not checkable, and the
 * prompt tells the model to omit the field instead.
 */
const reading = <T extends z.ZodTypeAny>(value: T) =>
    z.preprocess(
        absent,
        z
            .object({
                value,
                confidence: z.number().min(0).max(1),
                snippet: z
                    .string()
                    .trim()
                    .min(1)
                    .transform((s) => s.slice(0, SNIPPET_MAX_CHARS)),
            })
            .optional(),
    );

/** The answer of the extraction job; every key optional, absent = not stated in the document. */
export const ContractReadingSchema = z.object({
    counterparty: reading(z.string().trim().min(1)),
    contract_number: reading(z.string().trim().min(1)),
    start_date: reading(z.string().regex(ISO_DATE)),
    initial_term_months: reading(z.number().int().nonnegative()),
    renewal_months: reading(z.number().int().nonnegative()),
    notice_value: reading(z.number().int().nonnegative()),
    notice_unit: reading(enumOf(NOTICE_UNITS)),
    auto_renewal: reading(z.boolean()),
    amount: reading(z.number().nonnegative()),
    cycle: reading(enumOf(CONTRACT_CYCLES)),
});

export type ContractReading = z.output<typeof ContractReadingSchema>;

/** The contract fields this extraction can fill, in the order a frontend shows them. */
export const CONTRACT_PROPOSAL_FIELDS = [
    'counterparty',
    'contractNumber',
    'amount',
    'cycle',
    'startDate',
    'initialTermMonths',
    'renewalMonths',
    'noticeValue',
    'noticeUnit',
    'autoRenewal',
] as const;

export type ContractProposalField = (typeof CONTRACT_PROPOSAL_FIELDS)[number];

/** Answer key per field — the prompt speaks snake_case, the ledger camelCase. */
const ANSWER_KEY: Record<ContractProposalField, keyof ContractReading> = {
    counterparty: 'counterparty',
    contractNumber: 'contract_number',
    amount: 'amount',
    cycle: 'cycle',
    startDate: 'start_date',
    initialTermMonths: 'initial_term_months',
    renewalMonths: 'renewal_months',
    noticeValue: 'notice_value',
    noticeUnit: 'notice_unit',
    autoRenewal: 'auto_renewal',
};

/** Everything a contract field can hold here — serializable, so the proposal survives JSON/D-Bus. */
export type ContractProposalValue = string | number | boolean;

export interface ContractFieldSuggestion {
    field: ContractProposalField;
    /** What the document says. Never null: a field it does not state is left out of the proposal. */
    value: ContractProposalValue;
    /** 0…1 as the model reported it — a hint for the person, never a threshold the app applies. */
    confidence: number;
    /** The verbatim passage the value was read from, so it can be checked against the document. */
    snippet: string;
    /** The contract's value today; null when it has none, undefined while creating one. */
    current?: ContractProposalValue | null;
    /** False when accepting this field would change nothing. */
    differs: boolean;
}

/** A read document, ready for a human to confirm. Nothing is written until they do. */
export interface ContractProposal {
    /** The contract this would fill, or null when it would create one. */
    contractId: string | null;
    documentRef: string;
    /** Only the fields the document states, {@link CONTRACT_PROPOSAL_FIELDS} order. */
    fields: ContractFieldSuggestion[];
    /** Plain-language caveats: no text, text cut short, nothing found. */
    hints: string[];
    /** The model that answered, when the provider reports one. */
    model?: string;
}

function currentValue(c: ContractRecord, field: ContractProposalField): ContractProposalValue | null {
    switch (field) {
        case 'counterparty':
            return c.counterparty;
        case 'contractNumber':
            return c.contractNumber;
        case 'amount':
            return c.amount;
        case 'cycle':
            return c.cycle;
        case 'startDate':
            return c.startDate;
        case 'initialTermMonths':
            return c.initialTermMonths;
        case 'renewalMonths':
            return c.renewalMonths;
        case 'noticeValue':
            return c.noticeValue;
        case 'noticeUnit':
            return c.noticeUnit;
        case 'autoRenewal':
            return c.autoRenewal;
    }
}

const text = (v: ContractProposalValue): string | undefined => (typeof v === 'string' ? v : undefined);
const count = (v: ContractProposalValue): number | undefined => (typeof v === 'number' ? v : undefined);
const flag = (v: ContractProposalValue): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const oneOf = <T extends string>(values: readonly T[], v: ContractProposalValue): T | undefined =>
    typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * The ledger write an accepted field becomes. The schema already fixed the type per field; the
 * guards here are what keeps that promise visible to the compiler — a mismatch writes `undefined`,
 * which `saveContract` reads as "leave this field alone".
 */
function assign(input: ContractInput, field: ContractProposalField, value: ContractProposalValue): void {
    switch (field) {
        case 'counterparty':
            input.counterparty = text(value);
            return;
        case 'contractNumber':
            input.contractNumber = text(value);
            return;
        case 'amount':
            input.amount = count(value);
            return;
        case 'cycle':
            input.cycle = oneOf<ContractCycle>(CONTRACT_CYCLES, value);
            return;
        case 'startDate':
            input.startDate = text(value);
            return;
        case 'initialTermMonths':
            input.initialTermMonths = count(value);
            return;
        case 'renewalMonths':
            input.renewalMonths = count(value);
            return;
        case 'noticeValue':
            input.noticeValue = count(value);
            return;
        case 'noticeUnit':
            input.noticeUnit = oneOf<NoticeUnit>(NOTICE_UNITS, value);
            return;
        case 'autoRenewal':
            input.autoRenewal = flag(value);
            return;
    }
}

/**
 * Turn the fields a person ticked into one {@link ContractInput} — pure, so the dialog, the CLI and
 * a test all agree on what "accept these" means. A field that was not accepted is absent from the
 * result and therefore unchanged; an accepted field the proposal does not carry is ignored rather
 * than cleared, because "the AI did not find it" is not an instruction to empty it.
 */
export function contractInputFromProposal(
    proposal: ContractProposal,
    accept: readonly ContractProposalField[],
): ContractInput {
    const wanted = new Set(accept);
    const input: ContractInput = proposal.contractId ? { id: proposal.contractId } : {};
    for (const suggestion of proposal.fields) {
        if (wanted.has(suggestion.field)) assign(input, suggestion.field, suggestion.value);
    }
    return input;
}

/** The fields that would really change something — what a frontend ticks by default. */
export function changedFields(proposal: ContractProposal): ContractProposalField[] {
    return proposal.fields.filter((f) => f.differs).map((f) => f.field);
}

/**
 * Build the proposal from an answer and the contract it is for — the pure half, shared with the
 * tests so the diff can be checked without a model.
 */
export function buildContractProposal(
    reading: ContractReading,
    context: { contractId: string | null; documentRef: string; current?: ContractRecord; model?: string },
): ContractProposal {
    const fields: ContractFieldSuggestion[] = [];
    for (const field of CONTRACT_PROPOSAL_FIELDS) {
        const answered = reading[ANSWER_KEY[field]];
        if (!answered) continue;
        const current = context.current ? currentValue(context.current, field) : undefined;
        fields.push({
            field,
            value: answered.value,
            confidence: answered.confidence,
            snippet: answered.snippet,
            ...(context.current ? { current } : {}),
            differs: current !== answered.value,
        });
    }
    const hints: string[] = [];
    if (fields.length === 0) {
        hints.push(_('The document states none of the contract fields — enter them by hand.'));
    }
    return {
        contractId: context.contractId,
        documentRef: context.documentRef,
        fields,
        hints,
        ...(context.model ? { model: context.model } : {}),
    };
}

/**
 * Whether this extraction can run at all: the person's AI switch is on AND an engine is configured.
 * A frontend asks before offering the action, so "no AI" means the action is not there — not a
 * button that explains itself only after being pressed.
 */
export function contractExtractionAvailable(): boolean {
    if (!isAssistantEnabled()) return false;
    try {
        getLLMProvider();
        return true;
    } catch {
        return false;
    }
}

/** The person switched the assistant off; same wording as every other AI-off refusal. */
const assistantOffMessage = () =>
    _('The AI assistant is switched off. Switch it on under Settings → General, or enter the values by hand.');

/**
 * Translate a contract document ref (`paperless:<id>`, or a built-in id) into the id the resolved
 * provider knows. Fails loud on a ref from the other back-end instead of asking for a document that
 * would be somebody else's.
 */
export function providerDocumentId(provider: DmsProvider, documentRef: string): string {
    const ref = documentRef.trim();
    if (!ref) throw new Error(_('No document given.'));
    const prefixed = /^(builtin|paperless):(.+)$/.exec(ref);
    if (!prefixed) return ref;
    const [, dms, id] = prefixed;
    if (dms !== provider.kind) {
        throw new Error(_('This document belongs to a different document store than the contract — nothing was read.'));
    }
    return id;
}

export interface SuggestContractOptions {
    /** The document to read, as it is linked to the contract: `paperless:<id>` or a built-in id. */
    documentRef: string;
    /** Fill this contract: its entity picks the document store, its values make the diff. */
    contractId?: string;
    /** Required without a contract (creating one): whose document store holds the document. */
    entityId?: string;
    /** Cancels the AI call; it then fails as an `AiJobError` of kind `'cancelled'`. */
    signal?: AbortSignal;
}

/**
 * Read the contract data off one document and return it as a proposal.
 *
 * @throws when the AI is off or not configured, when the contract or document is unknown, and
 * `AiJobError` for every way the job itself can fail — `'denied'` when the selected model may not
 * see this data.
 */
export async function suggestContractFromDocument(opts: SuggestContractOptions): Promise<ContractProposal> {
    if (!isAssistantEnabled()) throw new Error(assistantOffMessage());
    // Before any document is read: an unconfigured engine must not look like a failed extraction.
    const provider = getLLMProvider();

    const detail = opts.contractId ? loadContract(opts.contractId) : undefined;
    if (opts.contractId && !detail) throw new Error(`Unbekannter Vertrag ${opts.contractId}`);
    const current = detail?.contract;
    const entityId = current?.entityId ?? opts.entityId;
    if (!entityId) {
        throw new Error(_('Without a contract the workspace entity is needed to find the document.'));
    }

    const dms = resolveEntityDms(entityId).provider;
    const doc = await getDocumentWithText(dms, providerDocumentId(dms, opts.documentRef));
    if (!doc.text?.trim()) {
        return {
            contractId: opts.contractId ?? null,
            documentRef: opts.documentRef,
            fields: [],
            hints: [_('The document has no readable text — enter the contract data by hand.')],
        };
    }

    const { value, model } = await completeJson(provider, {
        system: CONTRACT_EXTRACTION_SYSTEM_PROMPT,
        user: buildContractExtractionUserPrompt(doc.text, {
            title: doc.title,
            correspondent: doc.correspondent,
            contractName: current?.name ?? null,
        }),
        maxTokens: 2048,
        schema: ContractReadingSchema,
        ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const proposal = buildContractProposal(value, {
        contractId: opts.contractId ?? null,
        documentRef: opts.documentRef,
        ...(current ? { current } : {}),
        ...(model ? { model } : {}),
    });
    if (doc.textTruncated) {
        proposal.hints.push(_('Only the beginning of the document was read — check the fields against the original.'));
    }
    return proposal;
}
