/**
 * Reading a contract's term and price off one of its documents, for the native app — a thin adapter
 * over the core action (core/actions/contracts-extract.ts), which reaches the AI engine.
 *
 * No write lives here, deliberately: the action returns a PROPOSAL, and the dialog saves it through
 * `saveContractRecord` only after the person ticked the fields they accept. The cancel path is an
 * `AbortSignal` the dialog owns — a model answering after the dialog is gone must not land anywhere.
 */

import {
    type ContractProposal,
    contractExtractionAvailable,
    contractInputFromProposal,
    suggestContractFromDocument,
} from '../../../core/actions/contracts-extract.ts';
import type { AppEntity } from '../entities.ts';

export type {
    ContractFieldSuggestion,
    ContractProposal,
    ContractProposalField,
    ContractProposalValue,
} from '../../../core/actions/contracts-extract.ts';
export { contractExtractionAvailable, contractInputFromProposal };

/**
 * Read one document and return what it says about the contract. With `contractId` the proposal also
 * carries the contract's current values, so the dialog can show a diff instead of a list.
 */
export async function loadContractProposal(
    entity: AppEntity,
    opts: { documentRef: string; contractId?: string; signal?: AbortSignal },
): Promise<ContractProposal> {
    return suggestContractFromDocument({
        documentRef: opts.documentRef,
        entityId: entity.id,
        ...(opts.contractId ? { contractId: opts.contractId } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
}
