export {
    matchQontoPaperless,
    type MatchQontoPaperlessParams,
    type TransactionMatchItem,
    type MatchQontoPaperlessReport,
} from './match-qonto-paperless.ts';

export {
    normalizeFileName,
    documentsForSide,
    findCandidates,
    matchAttachment,
    type SyncConfigMatchSlice,
    type MatchCandidate,
    type AttachmentMatchResult,
} from './match.ts';

export {
    importAttachmentToPaperless,
    updateExistingDocumentQontoMetadata,
    type ImportAttachmentToPaperlessParams,
    type ImportAttachmentToPaperlessResult,
} from './import.ts';
