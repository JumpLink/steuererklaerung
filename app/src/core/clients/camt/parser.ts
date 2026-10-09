/**
 * Generic CAMT.052/053 XML parser using fast-xml-parser.
 * Accepts a file path or a directory (reads all .xml files recursively).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { Statement, Transaction, Balance } from 'lib-fints';
import type { CamtAccount, CamtStatementInfo } from './types.ts';

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) =>
        name === 'Ntry' ||
        name === 'NtryDtls' ||
        name === 'TxDtls' ||
        name === 'Rpt' ||
        name === 'Stmt' ||
        name === 'Bal',
});

// ── XML helpers ──────────────────────────────────────────────────────

function text(obj: unknown): string {
    if (obj == null) return '';
    if (typeof obj === 'string') return obj.trim();
    if (typeof obj === 'number') return String(obj);
    if (typeof obj === 'object' && '#text' in (obj as Record<string, unknown>)) {
        return String((obj as Record<string, unknown>)['#text']).trim();
    }
    return '';
}

function num(obj: unknown): number {
    const s = text(obj);
    return s ? parseFloat(s) || 0 : 0;
}

/**
 * Remittance info (`Ustrd`) is a repeatable element: a payer may split the
 * purpose across several lines, so fast-xml-parser yields a string OR a string[].
 * Join them so multi-line purposes (e.g. "Qonto top-up" + "Verkaufserlöse") are
 * preserved rather than dropped.
 */
function joinText(obj: unknown): string {
    if (Array.isArray(obj)) return obj.map(text).filter(Boolean).join(' ');
    return text(obj);
}

function parseDate(v: unknown): Date {
    const s = text(
        typeof v === 'object' && v !== null && 'Dt' in (v as Record<string, unknown>)
            ? (v as Record<string, unknown>).Dt
            : v,
    );
    return s ? new Date(s + 'T12:00:00.000Z') : new Date(0);
}

// ── CAMT parsing ─────────────────────────────────────────────────────

function parseBalance(bal: Record<string, unknown>): Balance {
    const amt = bal.Amt as Record<string, unknown> | undefined;
    const value = num(amt ? (amt['#text'] ?? amt) : bal.Amt);
    const ccy = text(amt?.['@_Ccy']) || 'EUR';
    const isDebit = text(bal.CdtDbtInd as unknown) === 'DBIT';
    return {
        date: parseDate(bal.Dt),
        currency: ccy,
        value: isDebit ? -value : value,
    };
}

function parseTransaction(ntry: Record<string, unknown>): Transaction {
    const amt = ntry.Amt as Record<string, unknown> | undefined;
    const rawAmount = num(amt ? (amt['#text'] ?? amt) : ntry.Amt);
    const isDebit = text(ntry.CdtDbtInd) === 'DBIT';
    const amount = isDebit ? -rawAmount : rawAmount;

    const bookgDt = parseDate(ntry.BookgDt);
    const valDt = parseDate(ntry.ValDt);

    // Transaction details (may be nested)
    const dtls = (ntry.NtryDtls as Record<string, unknown>[])?.at(0);
    const txDtls = (dtls?.TxDtls as Record<string, unknown>[])?.at(0) ?? {};

    const refs = (txDtls.Refs ?? {}) as Record<string, unknown>;
    const parties = (txDtls.RltdPties ?? {}) as Record<string, unknown>;
    const rmtInf = (txDtls.RmtInf ?? {}) as Record<string, unknown>;
    const txBkTxCd = (txDtls.BkTxCd ?? ntry.BkTxCd ?? {}) as Record<string, unknown>;
    const domn = (txBkTxCd.Domn ?? {}) as Record<string, unknown>;
    const fmly = (domn.Fmly ?? {}) as Record<string, unknown>;
    const prtry = (txBkTxCd.Prtry ?? {}) as Record<string, unknown>;

    // Extract party names (handle both <Dbtr><Nm> and <Dbtr><Pty><Nm>)
    const extractName = (party: unknown): string => {
        if (!party || typeof party !== 'object') return '';
        const p = party as Record<string, unknown>;
        if (p.Nm) return text(p.Nm);
        if (p.Pty && typeof p.Pty === 'object') return text((p.Pty as Record<string, unknown>).Nm);
        return '';
    };

    const extractIban = (acct: unknown): string => {
        if (!acct || typeof acct !== 'object') return '';
        const a = acct as Record<string, unknown>;
        const id = a.Id as Record<string, unknown> | undefined;
        return text(id?.IBAN ?? a.IBAN);
    };

    // For credits: remote party = debtor; for debits: remote party = creditor
    const remoteName = isDebit ? extractName(parties.Cdtr) : extractName(parties.Dbtr);
    const remoteAccount = isDebit ? extractIban(parties.CdtrAcct) : extractIban(parties.DbtrAcct);

    return {
        valueDate: valDt,
        entryDate: bookgDt,
        fundsCode: text(domn.Cd),
        amount,
        transactionType: text(fmly.Cd),
        customerReference: text(refs.EndToEndId),
        bankReference: text(refs.AcctSvcrRef ?? ntry.AcctSvcrRef),
        transactionCode: text(fmly.SubFmlyCd),
        bookingText: text(ntry.AddtlNtryInf),
        purpose: joinText(rmtInf.Ustrd),
        remoteBankId: '',
        remoteAccountNumber: remoteAccount,
        remoteName,
        e2eReference: text(refs.EndToEndId),
        mandateReference: text(refs.MndtId),
        additionalInformation: text(prtry.Cd),
    };
}

/** ISO date (YYYY-MM-DD) of a CAMT date or date-time element, or undefined. */
function isoDay(v: unknown): string | undefined {
    const s = text(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

function balanceCode(b: Record<string, unknown>): string {
    const cd = (b.Tp as Record<string, unknown>)?.CdOrPrtry as Record<string, unknown> | undefined;
    return text(cd?.Cd) || text(cd);
}

/**
 * What a statement says about itself: period (`FrToDt`), running number and whether it carried the
 * opening/closing balance at all — the parsed {@link Statement} fills a missing balance with 0, which
 * would read as a real balance. `PRCD` (previous closing) stands in for a missing `OPBD`.
 */
function parseStatementInfo(rpt: Record<string, unknown>): CamtStatementInfo {
    const frTo = (rpt.FrToDt ?? {}) as Record<string, unknown>;
    const balances = (rpt.Bal as Record<string, unknown>[]) ?? [];
    const open = balances.find((b) => balanceCode(b) === 'OPBD') ?? balances.find((b) => balanceCode(b) === 'PRCD');
    const close = balances.find((b) => balanceCode(b) === 'CLBD');
    const seqText = text(rpt.ElctrncSeqNb) || text(rpt.LglSeqNb);
    const seq = /^\d+$/.test(seqText) ? Number(seqText) : undefined;
    return {
        from: isoDay(frTo.FrDtTm) ?? isoDay(frTo.FrDt),
        to: isoDay(frTo.ToDtTm) ?? isoDay(frTo.ToDt),
        seq,
        opening: open
            ? { date: isoDay((open.Dt as Record<string, unknown>)?.Dt ?? open.Dt), value: parseBalance(open).value }
            : undefined,
        closing: close
            ? { date: isoDay((close.Dt as Record<string, unknown>)?.Dt ?? close.Dt), value: parseBalance(close).value }
            : undefined,
    };
}

function parseReport(rpt: Record<string, unknown>): { account: CamtAccount; statement: Statement } {
    const acct = (rpt.Acct ?? {}) as Record<string, unknown>;
    const acctId = (acct.Id ?? {}) as Record<string, unknown>;
    const ownr = (acct.Ownr ?? {}) as Record<string, unknown>;
    const svcr = (acct.Svcr ?? {}) as Record<string, unknown>;
    const finInstn = (svcr.FinInstnId ?? {}) as Record<string, unknown>;

    const account: CamtAccount = {
        iban: text(acctId.IBAN),
        currency: text(acct.Ccy),
        ownerName: text(ownr.Nm),
        bankName: text(finInstn.Nm),
        bic: text(finInstn.BICFI),
    };

    const balances = (rpt.Bal as Record<string, unknown>[]) ?? [];
    const openBal = balances.find(
        (b) =>
            text((b.Tp as Record<string, unknown>)?.CdOrPrtry as Record<string, unknown> | undefined) === 'OPBD' ||
            text(((b.Tp as Record<string, unknown>)?.CdOrPrtry as Record<string, unknown>)?.Cd) === 'OPBD',
    );
    const closeBal = balances.find(
        (b) => text(((b.Tp as Record<string, unknown>)?.CdOrPrtry as Record<string, unknown>)?.Cd) === 'CLBD',
    );

    const entries = (rpt.Ntry as Record<string, unknown>[]) ?? [];
    const transactions = entries.map(parseTransaction);

    const statement: Statement = {
        openingBalance: openBal ? parseBalance(openBal) : { date: new Date(0), currency: 'EUR', value: 0 },
        closingBalance: closeBal ? parseBalance(closeBal) : { date: new Date(0), currency: 'EUR', value: 0 },
        transactions,
    };

    return { account, statement };
}

// ── File handling ────────────────────────────────────────────────────

function collectXmlFiles(inputPath: string): string[] {
    const resolved = resolve(inputPath);
    const stat = statSync(resolved);

    if (stat.isFile() && resolved.endsWith('.xml')) {
        return [resolved];
    }

    if (stat.isDirectory()) {
        const files: string[] = [];
        for (const entry of readdirSync(resolved, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.xml')) {
                files.push(join(resolved, entry.name));
            } else if (entry.isDirectory()) {
                files.push(...collectXmlFiles(join(resolved, entry.name)));
            }
        }
        return files.sort();
    }

    return [];
}

/**
 * Read an XML file honoring its declared prolog encoding. Qonto exports CAMT as
 * UTF-8; many German banks (Volksbank et al.) use ISO-8859-1/Windows-1252. We
 * sniff `encoding="…"` from the prolog and decode accordingly, defaulting to
 * UTF-8 — reading UTF-8 as latin1 would mangle umlauts (ä → Ã¤).
 */
function readXmlWithEncoding(file: string): string {
    const buf = readFileSync(file);
    const head = buf.subarray(0, 200).toString('latin1');
    const declared = /encoding=["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase();
    const isLatin1 = declared != null && /(latin1|iso-?8859-1|windows-1252|cp1252)/.test(declared);
    return buf.toString(isLatin1 ? 'latin1' : 'utf8');
}

// ── Public API ───────────────────────────────────────────────────────

export interface ParseCamtResult {
    files: string[];
    account: CamtAccount;
    statements: Statement[];
    /** Per statement (same order as `statements`): period, number and the balances it really carried. */
    infos: CamtStatementInfo[];
}

export function parseCamt(inputPath: string): ParseCamtResult {
    const files = collectXmlFiles(inputPath);
    if (files.length === 0) {
        throw new Error(`No .xml files found at: ${inputPath}`);
    }

    const allStatements: Statement[] = [];
    const infos: CamtStatementInfo[] = [];
    let account: CamtAccount = { iban: '', currency: '', ownerName: '', bankName: '', bic: '' };

    for (const file of files) {
        const xml = readXmlWithEncoding(file);
        const doc = xmlParser.parse(xml);

        // Navigate to reports: Document > BkToCstmrAcctRpt > Rpt (CAMT.052)
        // or Document > BkToCstmrStmt > Stmt (CAMT.053)
        const root = doc.Document ?? doc;
        const container = root.BkToCstmrAcctRpt ?? root.BkToCstmrStmt ?? root;
        const reports: Record<string, unknown>[] = container.Rpt ?? container.Stmt ?? [];

        for (const rpt of Array.isArray(reports) ? reports : [reports]) {
            const result = parseReport(rpt as Record<string, unknown>);
            if (!account.iban) account = result.account;
            allStatements.push(result.statement);
            infos.push(parseStatementInfo(rpt as Record<string, unknown>));
        }
    }

    // Sort transactions by date
    for (const stmt of allStatements) {
        stmt.transactions.sort((a, b) => new Date(a.valueDate).getTime() - new Date(b.valueDate).getTime());
    }

    return { files, account, statements: allStatements, infos };
}

export function getTransactionDate(tx: Transaction): string {
    const d = tx.valueDate instanceof Date ? tx.valueDate : new Date(tx.valueDate);
    return d.toISOString().slice(0, 10);
}
