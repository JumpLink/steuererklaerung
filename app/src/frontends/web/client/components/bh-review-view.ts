// <bh-review-view> — the guided Beleg-Eingang: a queue of receipts not yet assigned to a booking,
// each shown with a preview + its metadata + the amount-matching transaction candidates, and a
// one-click "Verknüpfen" (link). That link is the review WRITE feature, wired to the existing
// /api/documents/:id/link action (no new backend path). Read side: /api/documents + /api/transactions.

import { api } from '../lib/api.ts';
import { esc, eur, deDate } from '../lib/format.ts';

type Doc = Awaited<ReturnType<typeof api.documents>>['documents'][number];
type Row = Awaited<ReturnType<typeof api.transactions>>['rows'][number];

export class BhReviewView extends HTMLElement {
    private entity = '';
    private year = 2025;
    private docs: Doc[] = [];
    private rows: Row[] = [];
    private sel = 0;
    /** After a link: the confirm/correct step keyed on the chosen booking (link-first-then-classify). */
    private pending: { doc: Doc; txId: string } | null = null;
    /** The year's EÜR categories (from /api/euer) — the Kategorie options in the confirm step. */
    private categories: string[] = [];

    async connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Beleg-Eingang ${this.year}…</div>`;
        try {
            const [docsRes, txRes, euerRes] = await Promise.all([
                api.documents(this.entity, this.year),
                api.transactions(this.entity, this.year),
                api.euer(this.entity, this.year).catch(() => null), // categories are best-effort
            ]);
            this.docs = docsRes.documents.filter((d) => d.linkedTxIds.length === 0);
            this.rows = txRes.rows;
            if (euerRes) {
                const cats = [...euerRes.aggregate.income, ...euerRes.aggregate.expenses].map((c) => c.category);
                this.categories = [...new Set(cats)].sort((a, b) => a.localeCompare(b, 'de'));
            }
        } catch (e) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(String(e))}</adw-card>`;
            return;
        }
        this.sel = 0;
        this.render();
    }

    private render() {
        if (this.pending) return this.renderConfirm();
        if (!this.docs.length) {
            this.innerHTML = `<adw-status-page icon="emblem-ok-symbolic" title="Alles zugeordnet" description="Alle Belege im Eingang sind einer Buchung zugeordnet. Neue Belege aus Import & E-Mail erscheinen automatisch hier."></adw-status-page>`;
            return;
        }
        const list = this.docs
            .map(
                (d, i) => `
        <button class="bh-rev-item${i === this.sel ? ' sel' : ''}" data-i="${i}">
          <div class="bh-rev-item-main"><div class="bh-rev-item-t">${esc(d.correspondent ?? d.title ?? 'Beleg')}</div><div class="bh-rev-item-s">${esc(d.invoiceNumber ?? '')}${d.created ? ` · ${esc(deDate(d.created))}` : ''}</div></div>
          <span class="bh-num">${d.gross != null ? eur(d.gross) : ''}</span>
        </button>`,
            )
            .join('');
        this.innerHTML = `
      <div class="bh-review">
        <aside class="bh-rev-list">
          <div class="bh-rev-head">Eingang · ${this.docs.length} offen</div>
          ${list}
        </aside>
        <section class="bh-rev-detail" data-el="detail"></section>
      </div>`;
        this.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) =>
            b.addEventListener('click', () => {
                this.sel = Number(b.dataset.i);
                this.render();
            }),
        );
        this.renderDetail();
    }

    private renderDetail() {
        const host = this.querySelector('[data-el="detail"]');
        if (!host) return;
        const d = this.docs[this.sel];
        if (!d) {
            host.innerHTML = '';
            return;
        }
        const url = api.documentFileUrl(this.entity, this.year, d.id);
        const mime = d.mimeType ?? '';
        // Only embed types that cannot execute script in this origin: images inline, PDFs in a frame.
        // Anything else (incl. an unknown/HTML upload) gets a safe open-in-new-tab link, never an iframe.
        const preview = mime.startsWith('image/')
            ? `<img src="${esc(url)}" alt="Beleg-Scan" class="bh-rev-img">`
            : mime === 'application/pdf'
              ? `<iframe src="${esc(url)}" class="bh-rev-frame" title="Beleg-Vorschau"></iframe>`
              : `<div class="bh-muted"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Beleg öffnen</a> — Vorschau nur für Bild/PDF.</div>`;
        const cands = this.rows
            .filter((r) => r.amount < 0 && d.gross != null && Math.abs(Math.abs(r.amount) - d.gross) < 0.02)
            .slice(0, 6);
        const candHtml = cands.length
            ? cands
                  .map(
                      (r) =>
                          `<div class="bh-rev-cand"><div class="bh-rev-cand-main"><div class="bh-rev-cand-t">${esc(r.counterparty ?? '')}</div><div class="bh-rev-cand-s">${esc(deDate(r.bookingDate))}${r.purpose ? ` · ${esc(r.purpose)}` : ''}</div></div><div class="bh-rev-cand-r"><span class="bh-num">${eur(r.amount)}</span><button class="adw-button suggested-action" data-link="${esc(r.id)}">Verknüpfen</button></div></div>`,
                  )
                  .join('')
            : `<div class="bh-muted">Keine betragsgleiche Buchung gefunden — später manuell zuordnen.</div>`;
        // KI-Hinweis (ai_note): the AI's uncertainty rationale. Paperless-authored → MUST be esc()'d
        // (a prior stored-XSS came from un-esc()'d Paperless fields).
        const ki = d.aiNote
            ? `<div class="bh-rev-why bh-rev-ki"><span aria-hidden="true">✨</span> KI-Hinweis: ${esc(d.aiNote)}</div>`
            : '';
        host.innerHTML = `
      <div class="bh-rev-why"><span aria-hidden="true">⚠</span> Beleg noch keiner Buchung zugeordnet — passende Buchung wählen.</div>
      ${ki}
      <div class="bh-rev-grid">
        <div class="bh-rev-preview">${preview}</div>
        <div class="bh-rev-meta">
          <div class="bh-rev-vendor">${esc(d.correspondent ?? d.title ?? 'Beleg')}</div>
          <dl class="bh-def"><dt>Rechnungsnr.</dt><dd>${esc(d.invoiceNumber ?? '—')}</dd></dl>
          <dl class="bh-def"><dt>Datum</dt><dd>${d.created ? esc(deDate(d.created)) : '—'}</dd></dl>
          <dl class="bh-def"><dt>Betrag brutto</dt><dd class="bh-num">${d.gross != null ? eur(d.gross) : '—'}</dd></dl>
          <h3 class="bh-rev-h">Buchung zuordnen</h3>
          ${candHtml}
        </div>
      </div>`;
        host.querySelectorAll<HTMLButtonElement>('[data-link]').forEach((b) =>
            b.addEventListener('click', () => void this.link(d.id, b.dataset.link ?? '')),
        );
    }

    private async link(docId: string, txId: string) {
        try {
            await api.linkDocument(this.entity, docId, txId);
        } catch (e) {
            console.error('link', e);
            return;
        }
        const doc = this.docs.find((d) => d.id === docId);
        if (!doc) {
            this.docs = this.docs.filter((d) => d.id !== docId);
            this.render();
            return;
        }
        // link-first-then-classify: show the confirm/correct step keyed on this booking's txId.
        this.pending = { doc, txId };
        this.render();
    }

    /**
     * The confirm/correct step after linking: read-only Beleg (+ KI-Hinweis), a Kategorie select
     * defaulting to "unverändert" (= accept the AI reading, NO override → number stays) plus the year's
     * categories to correct into (= a MANUAL override → number moves), and a Begründung. Mirrors the
     * native Beleg-Eingang confirm flow. All Paperless-authored / echoed text is esc()'d.
     */
    private renderConfirm() {
        const d = this.pending!.doc;
        const ki = d.aiNote
            ? `<div class="bh-rev-why bh-rev-ki"><span aria-hidden="true">✨</span> KI-Hinweis: ${esc(d.aiNote)}</div>`
            : '';
        const opts = ['<option value="">— unverändert (KI-Vorschlag übernehmen) —</option>']
            .concat(this.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`))
            .join('');
        this.innerHTML = `
      <div class="bh-rev-confirm">
        <div class="bh-rev-why"><span aria-hidden="true">✅</span> Beleg verknüpft — prüfen und bestätigen.</div>
        ${ki}
        <div class="bh-rev-vendor">${esc(d.correspondent ?? d.title ?? 'Beleg')}</div>
        <dl class="bh-def"><dt>Rechnungsnr.</dt><dd>${esc(d.invoiceNumber ?? '—')}</dd></dl>
        <dl class="bh-def"><dt>Datum</dt><dd>${d.created ? esc(deDate(d.created)) : '—'}</dd></dl>
        <dl class="bh-def"><dt>Betrag brutto</dt><dd class="bh-num">${d.gross != null ? eur(d.gross) : '—'}</dd></dl>
        <h3 class="bh-rev-h">Kategorie</h3>
        <select data-el="cat" class="bh-select">${opts}</select>
        <h3 class="bh-rev-h">Begründung (optional)</h3>
        <input data-el="note" type="text" class="bh-input" />
        <button class="adw-button suggested-action" data-confirm>Bestätigen und weiter</button>
      </div>`;
        this.querySelector('[data-confirm]')?.addEventListener('click', () => void this.confirmDecision());
    }

    /**
     * POST the decision, then advance the queue. `category === undefined` (empty select) = ACCEPT
     * (aiNoteAccepted, no override → EÜR/USt unchanged); a category = OVERRIDE → the number moves after
     * the server's coalesced rebuild. aiNoteAccepted is always true, exactly like native.
     */
    private async confirmDecision() {
        if (!this.pending) return;
        const { doc, txId } = this.pending;
        const cat = (this.querySelector('[data-el="cat"]') as HTMLSelectElement | null)?.value || undefined;
        const note = (this.querySelector('[data-el="note"]') as HTMLInputElement | null)?.value.trim() || undefined;
        try {
            await api.recordDecision(this.entity, doc.id, {
                txId,
                category: cat,
                note,
                aiNote: doc.aiNote ?? undefined,
                aiNoteAccepted: true,
            });
        } catch (e) {
            console.error('decision', e);
            return;
        }
        this.pending = null;
        this.docs = this.docs.filter((x) => x.id !== doc.id);
        if (this.sel >= this.docs.length) this.sel = Math.max(0, this.docs.length - 1);
        this.render();
    }
}

customElements.define('bh-review-view', BhReviewView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-review-view': BhReviewView;
    }
}
