/**
 * Verträge on the SQLite `contracts`, `contract_transactions` and `contract_documents` tables
 * (schema v27, ADR 0004). Pure data layer like refunds/repo.ts: every mutation takes the caller's
 * `at` timestamp and appends an `audit_log` row (`contract.*`) inside the same db transaction.
 */

import type { LedgerDatabase } from "../ledger/db.ts";
import { withTransaction } from "../ledger/db.ts";
import type {
  ContractCycle,
  ContractDocumentRecord,
  ContractDocumentRole,
  ContractInput,
  ContractPaymentMethod,
  ContractRecord,
  ContractStatus,
  ContractTransactionRecord,
  ContractTxStatus,
  NoticeUnit,
} from "./types.ts";

interface ContractRow {
  id: string;
  entity_id: string;
  name: string;
  counterparty: string | null;
  counterparty_ref: string | null;
  contract_number: string | null;
  account_key: string | null;
  category: string | null;
  amount: number | null;
  cycle: string | null;
  amount_tolerance: number | null;
  start_date: string | null;
  initial_term_months: number | null;
  renewal_months: number | null;
  notice_value: number | null;
  notice_unit: string | null;
  auto_renewal: number;
  end_date: string | null;
  payment_method: string | null;
  creditor_id: string | null;
  mandate_reference: string | null;
  counterparty_iban: string | null;
  match_text: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ContractRow): ContractRecord {
  return {
    id: row.id,
    entityId: row.entity_id,
    name: row.name,
    counterparty: row.counterparty,
    counterpartyRef: row.counterparty_ref,
    contractNumber: row.contract_number,
    accountKey: row.account_key,
    category: row.category,
    amount: row.amount,
    cycle: row.cycle as ContractCycle | null,
    amountTolerance: row.amount_tolerance,
    startDate: row.start_date,
    initialTermMonths: row.initial_term_months,
    renewalMonths: row.renewal_months,
    noticeValue: row.notice_value,
    noticeUnit: row.notice_unit as NoticeUnit | null,
    autoRenewal: row.auto_renewal !== 0,
    endDate: row.end_date,
    paymentMethod: row.payment_method as ContractPaymentMethod | null,
    creditorId: row.creditor_id,
    mandateReference: row.mandate_reference,
    counterpartyIban: row.counterparty_iban,
    matchText: row.match_text,
    status: row.status as ContractStatus,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record field → column, for every field an update may set. */
const COLUMNS: ReadonlyArray<[Exclude<keyof ContractInput, "id" | "entityId">, string]> = [
  ["name", "name"],
  ["counterparty", "counterparty"],
  ["counterpartyRef", "counterparty_ref"],
  ["contractNumber", "contract_number"],
  ["accountKey", "account_key"],
  ["category", "category"],
  ["amount", "amount"],
  ["cycle", "cycle"],
  ["amountTolerance", "amount_tolerance"],
  ["startDate", "start_date"],
  ["initialTermMonths", "initial_term_months"],
  ["renewalMonths", "renewal_months"],
  ["noticeValue", "notice_value"],
  ["noticeUnit", "notice_unit"],
  ["autoRenewal", "auto_renewal"],
  ["endDate", "end_date"],
  ["paymentMethod", "payment_method"],
  ["creditorId", "creditor_id"],
  ["mandateReference", "mandate_reference"],
  ["counterpartyIban", "counterparty_iban"],
  ["matchText", "match_text"],
  ["status", "status"],
  ["notes", "notes"],
];

function toSql(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as string | number;
}

function log(db: LedgerDatabase, action: string, contractId: string, detail: Record<string, unknown>, at: string): void {
  db.prepare(`INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)`).run(
    at,
    action,
    JSON.stringify({ contractId, ...detail }),
  );
}

export function getContract(db: LedgerDatabase, id: string): ContractRecord | undefined {
  const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id) as unknown as ContractRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

/** Contracts, oldest first; archived ones only with `includeArchived`. */
export function listContracts(
  db: LedgerDatabase,
  opts: { entityId?: string; includeArchived?: boolean } = {},
): ContractRecord[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.entityId) {
    where.push("entity_id = ?");
    args.push(opts.entityId);
  }
  if (!opts.includeArchived) where.push("status <> 'archived'");
  const sql = `SELECT * FROM contracts${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
  return (db.prepare(sql).all(...args) as unknown as ContractRow[]).map(rowToRecord);
}

/**
 * Create a contract (no `id`, or an id not stored yet) or update one: only the fields present in
 * `input` change, `null` clears one. A new contract needs `entityId` and `name`.
 */
export function saveContract(db: LedgerDatabase, input: ContractInput, at: string): ContractRecord {
  const existing = input.id ? getContract(db, input.id) : undefined;
  const id = existing?.id ?? input.id ?? `ct_${crypto.randomUUID()}`;
  withTransaction(db, () => {
    if (!existing) {
      if (!input.entityId || !input.name) throw new Error("A new contract needs entityId and name");
      const cols = ["id", "entity_id", "created_at", "updated_at"];
      const vals: (string | number | null)[] = [id, input.entityId, at, at];
      for (const [field, col] of COLUMNS) {
        if (input[field] === undefined) continue;
        cols.push(col);
        vals.push(toSql(input[field]));
      }
      db.prepare(`INSERT INTO contracts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
        ...vals,
      );
      log(db, "contract.create", id, { entityId: input.entityId, name: input.name }, at);
      return;
    }
    if (input.entityId && input.entityId !== existing.entityId) {
      throw new Error(`Contract ${id} belongs to entity ${existing.entityId}`);
    }
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const changed: string[] = [];
    for (const [field, col] of COLUMNS) {
      if (input[field] === undefined) continue;
      if (field === "name" && !input.name) throw new Error("The name must not be empty");
      sets.push(`${col} = ?`);
      vals.push(toSql(input[field]));
      changed.push(field);
    }
    if (sets.length === 0) return;
    db.prepare(`UPDATE contracts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, at, id);
    log(db, "contract.update", id, { fields: changed }, at);
  });
  const saved = getContract(db, id);
  if (!saved) throw new Error("Contract failed to persist");
  return saved;
}

/** Hide a contract from the default list. Links and documents stay. False if unknown. */
export function archiveContract(db: LedgerDatabase, id: string, at: string): boolean {
  if (!getContract(db, id)) return false;
  withTransaction(db, () => {
    db.prepare(`UPDATE contracts SET status = 'archived', updated_at = ? WHERE id = ?`).run(at, id);
    log(db, "contract.archive", id, {}, at);
  });
  return true;
}

interface ContractTxRow {
  contract_id: string;
  tx_id: string;
  status: string;
  decided_at: string;
  decided_by: string | null;
}

function txRowToRecord(row: ContractTxRow): ContractTransactionRecord {
  return {
    contractId: row.contract_id,
    txId: row.tx_id,
    status: row.status as ContractTxStatus,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

/** Links and rejections of one contract, or of all contracts. */
export function getContractTransactions(db: LedgerDatabase, contractId?: string): ContractTransactionRecord[] {
  const rows = contractId
    ? db.prepare(`SELECT * FROM contract_transactions WHERE contract_id = ? ORDER BY decided_at`).all(contractId)
    : db.prepare(`SELECT * FROM contract_transactions ORDER BY decided_at`).all();
  return (rows as unknown as ContractTxRow[]).map(txRowToRecord);
}

/**
 * Link a booking to a contract or reject it as a candidate; `null` removes the decision. A booking
 * belongs to at most one contract, so linking drops a link of the same booking to another one.
 */
export function setContractTransaction(
  db: LedgerDatabase,
  contractId: string,
  txId: string,
  status: ContractTxStatus | null,
  at: string,
  decidedBy?: string | null,
): void {
  if (!getContract(db, contractId)) throw new Error(`Unknown contract ${contractId}`);
  withTransaction(db, () => {
    if (status === null) {
      db.prepare(`DELETE FROM contract_transactions WHERE contract_id = ? AND tx_id = ?`).run(contractId, txId);
      log(db, "contract.unlink_tx", contractId, { txId }, at);
      return;
    }
    if (status === "linked") {
      db.prepare(`DELETE FROM contract_transactions WHERE tx_id = ? AND status = 'linked' AND contract_id <> ?`).run(
        txId,
        contractId,
      );
    }
    db.prepare(
      `INSERT INTO contract_transactions (contract_id, tx_id, status, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(contract_id, tx_id) DO UPDATE SET
         status = excluded.status, decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
    ).run(contractId, txId, status, at, decidedBy ?? null);
    log(db, status === "linked" ? "contract.link_tx" : "contract.reject_tx", contractId, { txId, decidedBy: decidedBy ?? null }, at);
  });
}

interface ContractDocRow {
  contract_id: string;
  document_ref: string;
  role: string;
  linked_at: string;
}

/** Documents of one contract, or of all contracts. */
export function getContractDocuments(db: LedgerDatabase, contractId?: string): ContractDocumentRecord[] {
  const rows = contractId
    ? db.prepare(`SELECT * FROM contract_documents WHERE contract_id = ? ORDER BY linked_at`).all(contractId)
    : db.prepare(`SELECT * FROM contract_documents ORDER BY linked_at`).all();
  return (rows as unknown as ContractDocRow[]).map((r) => ({
    contractId: r.contract_id,
    documentRef: r.document_ref,
    role: r.role as ContractDocumentRole,
    linkedAt: r.linked_at,
  }));
}

/** Attach a document (re-attaching updates the role) or, with `role: null`, detach it. */
export function setContractDocument(
  db: LedgerDatabase,
  contractId: string,
  documentRef: string,
  role: ContractDocumentRole | null,
  at: string,
): void {
  if (!getContract(db, contractId)) throw new Error(`Unknown contract ${contractId}`);
  withTransaction(db, () => {
    if (role === null) {
      db.prepare(`DELETE FROM contract_documents WHERE contract_id = ? AND document_ref = ?`).run(contractId, documentRef);
      log(db, "contract.unlink_document", contractId, { documentRef }, at);
      return;
    }
    db.prepare(
      `INSERT INTO contract_documents (contract_id, document_ref, role, linked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(contract_id, document_ref) DO UPDATE SET role = excluded.role`,
    ).run(contractId, documentRef, role, at);
    log(db, "contract.link_document", contractId, { documentRef, role }, at);
  });
}
