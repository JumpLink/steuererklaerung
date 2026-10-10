// <bh-assistent-view> — "Assistent": ask a question about the active entity's figures.
// Single-turn Q&A: posts to /api/chat, polls the job, shows the answer. The LLM runs
// server-side over the aggregated cache data (no raw IBANs/tax IDs). KI, keine Steuerberatung.

import { api } from '../lib/api.ts';
import { esc } from '../lib/format.ts';
import { assistantExampleIds, type AssistantExampleId } from '../../../../core/actions/assistant/examples.ts';
import type { Capabilities } from '../../../../core/countries/types.ts';
import type { EstIntakeProposal } from '../../../../core/actions/elster/est-intake-topics.ts';

/** The web chat is German-only; the core picks which of these an entity gets. */
function exampleText(id: AssistantExampleId, year: number): string {
    switch (id) {
        case 'biggest-expenses':
            return `Was sind meine größten Ausgaben ${year}?`;
        case 'missing-receipts':
            return 'Welche Buchungen haben noch keinen Beleg?';
        case 'find-receipts':
            return 'Finde die Hetzner-Rechnungen in Paperless.';
        case 'vat-due':
            return 'Wie viel Umsatzsteuer muss ich zahlen?';
        case 'deadlines':
            return 'Was muss ich bis wann abgeben?';
        case 'est-entlastungsbetrag':
            return 'Hilf mir beim Entlastungsbetrag für Alleinerziehende.';
        case 'est-kinderbetreuung':
            return 'Ich hatte Kinderbetreuungskosten für mein Kind.';
        case 'est-elterngeld':
            return 'Ich habe Elterngeld zurückgezahlt.';
    }
}

export class BhAssistentView extends HTMLElement {
    private entity = '';
    private year = 2025;
    private examples: string[] = [];

    connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.year = Number(this.getAttribute('year')) || 2025;
        this.examples = this.exampleList();
        this.render();
    }

    private exampleList(): string[] {
        let caps: Partial<Capabilities> = {};
        try {
            caps = JSON.parse(this.getAttribute('capabilities') ?? '{}') as Partial<Capabilities>;
        } catch {
            // No capabilities passed: offer only the bookkeeping questions.
        }
        const ids = assistantExampleIds(
            {
                vatReturn: caps.vatReturn === true,
                taxDeadlines: caps.taxDeadlines === true,
                incomeTax: caps.incomeTax === true,
            },
            {
                hasEst: this.getAttribute('has-est') === 'true',
                business: this.getAttribute('kind') !== 'privat',
                receiptSearch: true,
            },
        );
        return ids.map((id) => exampleText(id, this.year));
    }

    private render() {
        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Fragen zu deinen Zahlen ${this.year} · KI, keine Steuerberatung</div>
      </header>
      <div class="bh-chat">
        <div class="bh-chat-answer" data-el="answer" aria-live="polite"></div>
        <div class="bh-chat-examples">${this.examples.map((e, i) => `<button class="bh-chip" data-ex="${i}">${esc(e)}</button>`).join('')}</div>
        <form class="bh-chat-form" data-el="form">
          <textarea class="bh-chat-input" data-el="input" rows="2" placeholder="Frag etwas zu deinen Zahlen …"></textarea>
          <button class="adw-button suggested-action bh-chat-send" type="submit">Fragen</button>
        </form>
      </div>`;

        const form = this.querySelector('[data-el="form"]') as HTMLFormElement;
        const input = this.querySelector('[data-el="input"]') as HTMLTextAreaElement;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            void this.ask(input.value);
        });
        this.querySelectorAll('[data-ex]').forEach((b) =>
            b.addEventListener('click', () => {
                input.value = this.examples[Number((b as HTMLElement).dataset.ex)] ?? '';
                void this.ask(input.value);
            }),
        );
    }

    private async ask(q: string) {
        const question = q.trim();
        if (!question) return;
        const answerEl = this.querySelector('[data-el="answer"]') as HTMLElement;
        const send = this.querySelector('[data-el="form"] button') as HTMLButtonElement;
        answerEl.innerHTML = `<div class="bh-chat-q">${esc(question)}</div><div class="bh-chat-thinking">Denkt nach …</div>`;
        send.disabled = true;
        try {
            const { answer, proposals } = await api.chat(this.entity, this.year, question);
            answerEl.innerHTML =
                `<div class="bh-chat-q">${esc(question)}</div><div class="bh-chat-a">${esc(answer).replace(/\n/g, '<br>')}</div>` +
                proposals.map((p, i) => this.proposalCard(p, i)).join('');
            // Wire each proposal's „Übernehmen" — the write happens only on this explicit click.
            proposals.forEach((p, i) => {
                const btn = answerEl.querySelector(`[data-apply="${i}"]`) as HTMLButtonElement | null;
                if (btn) btn.addEventListener('click', () => void this.applyProposal(p, btn));
            });
        } catch (err) {
            answerEl.innerHTML = `<div class="bh-chat-q">${esc(question)}</div><div class="bh-error">${esc(err instanceof Error ? err.message : err)}</div>`;
        } finally {
            send.disabled = false;
        }
    }

    /** One intake proposal as an accent APPROVE card (the write happens on the „Übernehmen" click). */
    private proposalCard(p: EstIntakeProposal, i: number): string {
        const hints = p.vorschau.hinweise
            .map((h) => `<div style="font-size:12px;opacity:.7;margin-top:2px;">• ${esc(h)}</div>`)
            .join('');
        return `<div class="bh-proposal" style="margin-top:12px;padding:12px 14px;border-radius:12px;background:color-mix(in srgb, var(--accent-bg-color, #3584e4) 12%, transparent);">
            <div style="font-weight:700;font-size:13px;opacity:.85;">Vorschlag · ${esc(p.titel)}</div>
            <div style="font-weight:700;font-size:16px;margin-top:4px;">${esc(p.vorschau.ergebnis)}</div>
            ${hints}
            <div style="margin-top:10px;"><button class="adw-button suggested-action" data-apply="${i}">Übernehmen</button></div>
          </div>`;
    }

    /** Persist a proposal via the gated apply endpoint; reflect success on the button. */
    private async applyProposal(p: EstIntakeProposal, btn: HTMLButtonElement): Promise<void> {
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = 'Übernehme …';
        try {
            const r = await api.applyEstIntake(this.entity, this.year, p);
            btn.textContent = `Übernommen ✓ (${r.ergebnis})`;
            btn.classList.remove('suggested-action');
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prev ?? 'Übernehmen';
            // Safe DOM (no HTML sink): the error text goes in via textContent.
            const errEl = document.createElement('div');
            errEl.className = 'bh-error';
            errEl.textContent = err instanceof Error ? err.message : String(err);
            btn.after(errEl);
        }
    }
}

customElements.define('bh-assistent-view', BhAssistentView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-assistent-view': BhAssistentView;
    }
}
