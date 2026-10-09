// <bh-documents-view> — the Belege browser: searchable Adwaita card grid over the per-entity
// DMS (built-in or Paperless), DMS-agnostic at the view layer. Built-in entities can upload a
// receipt and run the AI analysis (metadata + OCR text in one pass) + link the proposed booking.
// File preview is loaded through the file endpoint (built-in serves inline; Paperless is prepared
// by a background job that this view polls), so both back-ends view inline.

import { api, type DmsDocument, type DocumentsResponse, type AnalyzeResult } from '../lib/api.ts';
import { esc, eur, deDate } from '../lib/format.ts';
import { readBase64, sleep } from '../lib/view-helpers.ts';
import { herkunftSatz } from '../../../../core/dokumentregeln/regeln.ts';

type Filter = 'all' | 'linked' | 'unlinked';
const FILTER_LABEL: Record<Filter, string> = { all: 'Alle', linked: 'Verknüpft', unlinked: 'Ohne Buchung' };
const ICON: Record<string, string> = { pdf: '📄', image: '🖼' };

function iconFor(mime: string | null): string {
    if (mime === 'application/pdf') return ICON.pdf;
    if (mime?.startsWith('image/')) return ICON.image;
    return '🗎';
}

export class BhDocumentsView extends HTMLElement {
    private docs: DmsDocument[] = [];
    private dmsKind: DocumentsResponse['dmsKind'] = 'builtin';
    private filter: Filter = 'all';
    private query = '';
    private entity = '';
    private year = 2025;
    private closeOverlay: (() => void) | null = null;
    private thumbObserver: IntersectionObserver | null = null;

    async connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Belege ${this.year} …</div>`;
        try {
            const res = await api.documents(this.entity, this.year);
            this.docs = res.documents;
            this.dmsKind = res.dmsKind;
            this.render();
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    disconnectedCallback() {
        this.closeOverlay?.();
        this.thumbObserver?.disconnect();
    }

    private visible(): DmsDocument[] {
        const q = this.query.toLowerCase().trim();
        return this.docs.filter((d) => {
            if (this.filter === 'linked' && d.linkedTxIds.length === 0) return false;
            if (this.filter === 'unlinked' && d.linkedTxIds.length > 0) return false;
            if (!q) return true;
            return [d.title, d.correspondent, d.invoiceNumber, d.ocrText, ...d.tags].some((v) =>
                (v ?? '').toLowerCase().includes(q),
            );
        });
    }

    private render() {
        const canUpload = this.dmsKind === 'builtin';
        const chips = (['all', 'linked', 'unlinked'] as Filter[])
            .map(
                (f) =>
                    `<button class="bh-chip${f === this.filter ? ' selected' : ''}" data-f="${f}">${esc(FILTER_LABEL[f])}</button>`,
            )
            .join('');
        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">${this.docs.length} Belege · ${this.dmsKind === 'builtin' ? 'eingebautes DMS' : 'Paperless'}</div>
      </header>
      <div class="bh-doc-toolbar">
        <input class="bh-input bh-doc-search" data-el="q" type="search"
               placeholder="Suche Titel, Korrespondent, Rechnungsnr., Volltext, Tag …" value="${esc(this.query)}">
        ${canUpload ? '<button class="adw-button suggested-action" data-act="add">＋ Beleg hinzufügen</button>' : ''}
      </div>
      <div class="bh-filters" role="tablist">${chips}</div>
      <div class="bh-doc-grid" data-el="grid">${this.renderCards()}</div>
      <div data-el="overlay" hidden></div>`;

        const q = this.querySelector('[data-el="q"]') as HTMLInputElement;
        let t: ReturnType<typeof setTimeout> | undefined;
        q.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => {
                this.query = q.value;
                this.refreshGrid();
            }, 150);
        });
        this.querySelectorAll('.bh-chip').forEach((b) =>
            b.addEventListener('click', () => {
                this.filter = (b as HTMLElement).dataset.f as Filter;
                this.querySelectorAll('.bh-chip').forEach((x) =>
                    x.classList.toggle('selected', (x as HTMLElement).dataset.f === this.filter),
                );
                this.refreshGrid();
            }),
        );
        this.querySelector('[data-act="add"]')?.addEventListener('click', () => this.openUpload());
        this.wireGrid();
        this.wireThumbnails();
    }

    private refreshGrid() {
        const grid = this.querySelector('[data-el="grid"]');
        if (grid) {
            grid.innerHTML = this.renderCards();
            this.wireGrid();
            this.wireThumbnails();
        }
    }

    private renderCards(): string {
        const rows = this.visible();
        if (!rows.length) {
            const empty = this.docs.length
                ? { icon: 'system-search', title: 'Keine Treffer', desc: 'Andere Suche oder Filter versuchen.' }
                : {
                      icon: 'folder',
                      title: 'Noch keine Belege',
                      desc:
                          this.dmsKind === 'builtin'
                              ? 'Lade einen Beleg hoch — die KI liest ihn aus.'
                              : 'Für dieses Jahr sind keine Belege im Paperless hinterlegt.',
                  };
            return `<adw-status-page icon="${empty.icon}" title="${esc(empty.title)}" description="${esc(empty.desc)}"></adw-status-page>`;
        }
        return rows.map((d) => this.renderCard(d)).join('');
    }

    private renderCard(d: DmsDocument): string {
        const amount = d.gross != null ? eur(d.gross) : d.net != null ? eur(d.net) : '';
        const linked = d.linkedTxIds.length
            ? `<span class="bh-tag tf">⇄ ${d.linkedTxIds.length} Buchung${d.linkedTxIds.length > 1 ? 'en' : ''}</span>`
            : '<span class="bh-tag" style="opacity:.6">ohne Buchung</span>';
        const inv = d.invoiceNumber ? `<span class="bh-tag">Nr. ${esc(d.invoiceNumber)}</span>` : '';
        const tags = d.tags.map((tg) => `<span class="bh-chip-static">${esc(tg)}</span>`).join('');
        return `<article class="bh-doc-card" data-id="${esc(d.id)}" tabindex="0" role="button"
        aria-label="${esc(d.title || d.id)}">
        <div class="bh-doc-thumb" data-thumb-id="${esc(d.id)}"><span class="bh-doc-ico">${iconFor(d.mimeType)}</span></div>
        <div class="bh-doc-body">
          <div class="bh-doc-title">${esc(d.title || '(ohne Titel)')}</div>
          <div class="bh-doc-meta">${esc(d.correspondent || '—')} · ${esc(deDate(d.created))}</div>
          ${amount ? `<div class="bh-doc-amt bh-amt">${amount}</div>` : ''}
          <div class="bh-rowtags">${linked}${inv}</div>
          ${tags ? `<div class="bh-chips">${tags}</div>` : ''}
        </div>
      </article>`;
    }

    private wireGrid() {
        this.querySelectorAll('.bh-doc-card').forEach((card) => {
            const id = (card as HTMLElement).dataset.id ?? '';
            const open = () => {
                const doc = this.docs.find((d) => d.id === id);
                if (doc) this.openDetail(doc);
            };
            card.addEventListener('click', open);
            card.addEventListener('keydown', (e) => {
                const k = (e as KeyboardEvent).key;
                if (k === 'Enter' || k === ' ') {
                    e.preventDefault();
                    open();
                }
            });
        });
    }

    // ── Card thumbnails — lazily load each visible card's preview image (built-in renders
    //    locally, Paperless ships a WebP via a background job), swapping the placeholder icon.
    private wireThumbnails() {
        this.thumbObserver?.disconnect();
        const obs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const el = e.target as HTMLElement;
                    obs.unobserve(el);
                    void this.loadThumb(el.dataset.thumbId ?? '', el);
                }
            },
            { rootMargin: '300px' },
        );
        this.querySelectorAll('.bh-doc-thumb[data-thumb-id]').forEach((el) => obs.observe(el));
        this.thumbObserver = obs;
    }

    private async loadThumb(id: string, el: HTMLElement) {
        if (!id || el.dataset.thumbDone) return;
        const url = api.documentThumbnailUrl(this.entity, this.year, id);
        for (let i = 0; i < 30; i++) {
            let r: Response;
            try {
                r = await fetch(url);
            } catch {
                return;
            }
            if (r.status === 202) {
                await sleep(1200);
                continue;
            }
            if (!r.ok) return; // 404 → no preview available, keep the icon
            const blob = await r.blob();
            const ct = (r.headers.get('content-type') ?? blob.type ?? '').split(';')[0].trim();
            if (!ct.startsWith('image/')) return;
            const img = document.createElement('img');
            img.src = URL.createObjectURL(blob);
            img.alt = '';
            img.loading = 'lazy';
            el.dataset.thumbDone = '1';
            el.replaceChildren(img);
            return;
        }
    }

    // ── Overlay (modal/dialog) plumbing — ESC + backdrop close, focus the first control ──
    private mountOverlay(html: string): HTMLElement {
        this.closeOverlay?.();
        const overlay = this.querySelector('[data-el="overlay"]') as HTMLElement;
        overlay.innerHTML = html;
        // The container IS the fixed full-screen backdrop that centres the modal/dialog over
        // the page (reuses .bh-modal-backdrop; its display:flex overrides the [hidden] attr).
        overlay.className = 'bh-modal-backdrop';
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        const onBackdrop = (e: MouseEvent) => {
            if (e.target === overlay) close();
        };
        const close = () => {
            overlay.className = '';
            overlay.innerHTML = '';
            document.removeEventListener('keydown', onKey);
            overlay.removeEventListener('click', onBackdrop);
            this.closeOverlay = null;
        };
        this.closeOverlay = close;
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', onBackdrop);
        overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close()));
        return overlay;
    }

    // ── Upload (built-in only) ───────────────────────────────────────────────────────────
    private openUpload() {
        const overlay = this
            .mountOverlay(`<div class="bh-dialog" role="dialog" aria-modal="true" aria-labelledby="bh-up-t">
        <h2 id="bh-up-t">Beleg hinzufügen</h2>
        <label class="bh-field"><span>Datei (PDF, PNG, JPG)</span>
          <input class="bh-input" data-el="file" type="file" accept="application/pdf,image/*"></label>
        <label class="bh-field"><span>Mit Buchung verknüpfen (optional, Buchungs-id)</span>
          <input class="bh-input" data-el="tx" type="text" placeholder="leer lassen — KI schlägt später vor"></label>
        <div class="bh-dialog-actions">
          <button class="adw-button suggested-action" data-el="go">Hochladen</button>
          <button class="adw-button" data-close>Abbrechen</button>
        </div>
        <span class="bh-muted bh-dialog-status" data-el="st"></span>
      </div>`);
        const fileEl = overlay.querySelector('[data-el="file"]') as HTMLInputElement;
        const txEl = overlay.querySelector('[data-el="tx"]') as HTMLInputElement;
        const st = overlay.querySelector('[data-el="st"]') as HTMLElement;
        overlay.querySelector('[data-el="go"]')?.addEventListener('click', () => {
            const file = fileEl.files?.[0];
            if (!file) {
                st.textContent = 'Bitte eine Datei wählen.';
                return;
            }
            void this.doUpload(file, txEl.value.trim(), st);
        });
        fileEl.focus();
    }

    private async doUpload(file: File, linkTxId: string, st: HTMLElement) {
        st.textContent = 'Lade hoch …';
        try {
            const contentBase64 = await readBase64(file);
            await api.uploadDocument({
                entity: this.entity,
                year: this.year,
                filename: file.name,
                contentBase64,
                mimeType: file.type || undefined,
                linkTxId: linkTxId || undefined,
            });
            st.textContent = '✓ hochgeladen — aktualisiere …';
            await this.watchRebuild();
            this.closeOverlay?.();
            await this.reload();
        } catch (err) {
            st.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        }
    }

    // ── Detail modal: fields + inline preview + AI analyze + link proposals ───────────────
    private openDetail(d: DmsDocument) {
        const def = (label: string, val: string) =>
            val ? `<div class="bh-def"><dt>${esc(label)}</dt><dd>${esc(val)}</dd></div>` : '';
        const money = [
            d.net != null ? `Netto ${eur(d.net)}` : '',
            d.gross != null ? `Brutto ${eur(d.gross)}` : '',
            d.vat != null ? `USt ${eur(d.vat)}` : '',
        ]
            .filter(Boolean)
            .join(' · ');
        const dir = d.direction === 'incoming' ? 'Eingang' : d.direction === 'outgoing' ? 'Ausgang' : '';
        const links = d.linkedTxIds.length
            ? `<div class="bh-def"><dt>Buchungen</dt><dd>${d.linkedTxIds.map((t) => `<code>${esc(t)}</code>`).join(' ')}</dd></div>`
            : '';
        const ocr = d.ocrText
            ? `<details class="bh-ocr"><summary>Volltext (KI)</summary><pre>${esc(d.ocrText)}</pre></details>`
            : '';
        const canAi = this.dmsKind === 'builtin';
        const overlay = this
            .mountOverlay(`<div class="bh-modal" role="dialog" aria-modal="true" aria-labelledby="bh-d-t">
        <header class="bh-modal-head"><h2 id="bh-d-t">${esc(d.title || '(ohne Titel)')}</h2>
          <button class="adw-button flat bh-icon" data-close aria-label="Schließen">✕</button></header>
        <div class="bh-modal-body">
          <div class="bh-doc-preview" data-el="preview"><div class="bh-muted">Vorschau lädt …</div></div>
          <dl class="bh-deflist">
            ${def('Korrespondent', d.correspondent ?? '')}
            ${def('Datum', deDate(d.created))}
            ${def('Richtung', dir)}
            ${def('Dokumenttyp', d.documentType ?? '')}
            ${def('Kategorie', d.category ?? '')}
            ${d.ruleOrigin ? def('Herkunft', herkunftSatz(d.ruleOrigin)) : ''}
            ${def('Rechnungsnummer', d.invoiceNumber ?? '')}
            ${def('Beträge', money)}
            ${d.tags.length ? def('Tags', d.tags.join(', ')) : ''}
            ${links}
          </dl>
          ${ocr}
          ${canAi ? '<div class="bh-ai" data-el="ai"><button class="adw-button suggested-action" data-el="analyze">✦ Beleg analysieren (KI)</button><span class="bh-muted" data-el="aist"></span></div>' : ''}
        </div>
      </div>`);
        void this.loadPreview(d.id, overlay.querySelector('[data-el="preview"]') as HTMLElement, d.mimeType);
        if (canAi) {
            const st = overlay.querySelector('[data-el="aist"]') as HTMLElement;
            overlay.querySelector('[data-el="analyze"]')?.addEventListener('click', (e) => {
                (e.currentTarget as HTMLButtonElement).disabled = true;
                void this.doAnalyze(d.id, overlay.querySelector('[data-el="ai"]') as HTMLElement, st);
            });
        }
    }

    /** Load a file through the endpoint (built-in: immediate; Paperless: poll the prepare job). */
    private async loadPreview(id: string, host: HTMLElement, mime: string | null) {
        const url = api.documentFileUrl(this.entity, this.year, id);
        for (let i = 0; i < 90; i++) {
            const r = await fetch(url);
            if (r.status === 202) {
                host.innerHTML = '<div class="bh-muted">Beleg wird vom Server geladen …</div>';
                await sleep(1000);
                continue;
            }
            if (!r.ok) {
                host.innerHTML = '<div class="bh-muted">Vorschau nicht verfügbar.</div>';
                return;
            }
            const blob = await r.blob();
            const objUrl = URL.createObjectURL(blob);
            // Only embed types that cannot execute script; everything else is a download link.
            const ct = (r.headers.get('content-type') ?? mime ?? blob.type).split(';')[0].trim();
            host.innerHTML = ct.startsWith('image/')
                ? `<img src="${objUrl}" alt="Beleg">`
                : ct === 'application/pdf'
                  ? `<iframe src="${objUrl}" title="Beleg"></iframe>`
                  : `<a class="bh-link" href="${objUrl}" download>Datei herunterladen ↓</a>`;
            return;
        }
        host.innerHTML = '<div class="bh-muted">Zeitüberschreitung beim Laden.</div>';
    }

    private async doAnalyze(id: string, aiBox: HTMLElement, st: HTMLElement) {
        st.textContent = ' Analysiere … das kann etwas dauern.';
        try {
            const res = await api.analyzeDocument(this.entity, id);
            st.textContent = ' ✓ ausgelesen.';
            this.renderCandidates(aiBox, id, res);
            void this.watchRebuild().then(() => this.reload());
        } catch (err) {
            st.textContent = ` Fehler: ${err instanceof Error ? err.message : err}`;
            const btn = aiBox.querySelector('[data-el="analyze"]') as HTMLButtonElement | null;
            if (btn) btn.disabled = false;
        }
    }

    private renderCandidates(aiBox: HTMLElement, docId: string, res: AnalyzeResult) {
        const m = res.extraction.metadata;
        const summary = [
            m.invoiceNumber ? `Nr. ${m.invoiceNumber}` : '',
            m.correspondent ?? '',
            m.gross != null ? eur(m.gross) : '',
            m.date ?? '',
        ]
            .filter(Boolean)
            .map((s) => esc(s))
            .join(' · ');
        const cands = res.candidates
            .map(
                (c) =>
                    `<li><button class="bh-link" data-tx="${esc(c.id)}">${esc(deDate(c.bookingDate))} · ${eur(c.amount)} · ${esc(c.counterparty ?? '')}</button></li>`,
            )
            .join('');
        aiBox.innerHTML = `<div class="bh-ai-result">
        <div class="bh-muted">Erkannt: ${summary || '—'}</div>
        ${cands ? `<div class="bh-muted">Passende Buchungen — zum Verknüpfen wählen:</div><ul class="bh-cand">${cands}</ul>` : '<div class="bh-muted">Keine passende Buchung gefunden.</div>'}
        <span class="bh-muted" data-el="linkst"></span>
      </div>`;
        const linkst = aiBox.querySelector('[data-el="linkst"]') as HTMLElement;
        aiBox.querySelectorAll('[data-tx]').forEach((b) =>
            b.addEventListener('click', () => {
                const txId = (b as HTMLElement).dataset.tx ?? '';
                linkst.textContent = ' verknüpfe …';
                void api
                    .linkDocument(this.entity, docId, txId)
                    .then(() => {
                        linkst.textContent = ' ✓ verknüpft.';
                        return this.watchRebuild().then(() => this.reload());
                    })
                    .catch((err) => {
                        linkst.textContent = ` Fehler: ${err instanceof Error ? err.message : err}`;
                    });
            }),
        );
    }

    /** Poll the rebuild job until it settles (≤ ~90s) so the reloaded list reflects the write. */
    private async watchRebuild() {
        for (let i = 0; i < 90; i++) {
            try {
                const s = await api.documentsRebuild();
                if (s.status === 'done' || s.status === 'idle' || s.status === 'error') return;
            } catch {
                return;
            }
            await sleep(1000);
        }
    }

    private async reload() {
        try {
            const res = await api.documents(this.entity, this.year);
            this.docs = res.documents;
            this.dmsKind = res.dmsKind;
            this.refreshGrid();
            const result = this.querySelector('.bh-result');
            if (result)
                result.textContent = `${this.docs.length} Belege · ${this.dmsKind === 'builtin' ? 'eingebautes DMS' : 'Paperless'}`;
        } catch {
            /* keep current view */
        }
    }
}

customElements.define('bh-documents-view', BhDocumentsView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-documents-view': BhDocumentsView;
    }
}
