/**
 * BhAssistentPanel — the native KI-Assistant docked side panel (v3 design: `bh-ai`).
 *
 * A chat over the active entity-year: it asks the backend (`askAssistant`, the same in-process
 * `answer()` the web uses, Claude Agent SDK) and renders the reply as message bubbles. For a private-
 * ESt entity the assistant may return INTAKE PROPOSALS (§24b, Kinderbetreuung, …) — each rendered as
 * an APPROVE card: the write happens ONLY on the user's „Übernehmen" click (`applyProposal`), never by
 * the model. This is the native half of the approve-to-apply copilot; the model stays proposal-only.
 *
 * GJS-GUI → headless not verifiable (Sandbox Exit 144); build-verified + Devtools-screenshot. Set
 * `STEUER_APP_ASSIST_DEMO=1` to seed a demo conversation + proposal card for screenshotting without a live LLM.
 */

import GObject from '@girs/gobject-2.0';

import Template from './assistent-panel.blp';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import type { AppEntity } from './entities.ts';
import { _ } from './i18n.ts';
import { askAssistant } from './data/assistent.ts';
import type { ChatTurn } from '../../core/actions/assistant/chat.ts';
import { appSession } from './data/session.ts';
import { showToast } from './toast.ts';
import { applyProposal, buildProposal, type EstIntakeProposal } from '../../core/actions/elster/est-intake-topics.ts';

const EXAMPLES = [
    'Was waren meine größten Ausgaben?',
    'Welche Buchungen haben noch keinen Beleg?',
    'Wie viel Umsatzsteuer muss ich zahlen?',
];
const EST_EXAMPLES = [
    'Hilf mir beim Entlastungsbetrag für Alleinerziehende.',
    'Ich hatte Kinderbetreuungskosten für mein Kind.',
    'Ich habe Elterngeld zurückgezahlt.',
];

export class BhAssistentPanel extends Gtk.Box {
    private entity?: AppEntity;
    private year = 0;
    private busy = false;
    /** The running conversation, fed back each turn so the assistant can follow up (multi-turn). */
    private turns: ChatTurn[] = [];

    /** Called by the window to hide the panel (the header toggle owns the state). */
    onClose: (() => void) | null = null;
    /** Called after a proposal is applied — the shell re-reads the est snapshot + reloads views. */
    onApplied: (() => void) | null = null;

    declare private _messages: Gtk.Box;
    declare private _scroller: Gtk.ScrolledWindow;
    declare private _entry: Gtk.Entry;
    declare private _context_card: Gtk.Box;
    declare private _context_title: Gtk.Label;
    declare private _context_hint: Gtk.Label;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhAssistentPanel',
                Template,
                InternalChildren: ['messages', 'scroller', 'entry', 'context_card', 'context_title', 'context_hint'],
            },
            this,
        );
    }

    /** Template handler for the close button. The window owns the visibility. */
    private _onCloseClicked(): void {
        this.onClose?.();
    }

    /** Template handler for both the send button and Enter in the entry. */
    private _onSendClicked(): void {
        void this.onSend();
    }

    /** Point the panel at an entity-year and reset the conversation. */
    setContext(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        this.reset();
    }

    /** Name the currently open view in the context card so the assistant's help is in context (v3 §6). */
    setViewContext(title: string, hint: string): void {
        // One translatable sentence with a placeholder rather than a glued-together label: a
        // translator needs the whole line to choose its word order and its punctuation.
        this._context_title.set_label(title ? _('Context: %s').replace('%s', title) : '');
        this._context_hint.set_label(hint);
        this._context_card.set_visible(!!title);
    }

    // ── UI ──────────────────────────────────────────────────────────────────────────────────────

    private clearMessages(): void {
        let child = this._messages.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._messages.remove(child);
            child = next;
        }
    }

    /** Reset to the empty state: intro + example prompts (ESt-specific when the entity has an ESt config). */
    private reset(): void {
        this.clearMessages();
        this.turns = []; // new entity/year → fresh conversation
        const hasEst = !!this.entity?.hasEst;
        const intro = new Gtk.Label({
            label: hasEst
                ? 'Frag mich zu deinen Zahlen — oder lass dich beim Eintragen von Steuer-Sachverhalten helfen. Zum Beispiel:'
                : 'Frag mich etwas zu deinen Zahlen. Zum Beispiel:',
            xalign: 0,
            wrap: true,
            cssClasses: ['dim-label'],
        });
        this._messages.append(intro);
        for (const ex of hasEst ? [...EXAMPLES.slice(0, 1), ...EST_EXAMPLES] : EXAMPLES) {
            const chip = new Gtk.Button({ label: ex, cssClasses: ['pill'], halign: Gtk.Align.START });
            chip.connect('clicked', () => {
                this._entry.set_text(ex);
                void this.onSend();
            });
            this._messages.append(chip);
        }
        if (process.env.STEUER_APP_ASSIST_DEMO && hasEst) this.seedDemo();
    }

    // ── Messaging ───────────────────────────────────────────────────────────────────────────────

    private appendBubble(textStr: string, mine: boolean): void {
        const label = new Gtk.Label({ label: textStr, xalign: 0, wrap: true, selectable: true });
        label.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
        const bubble = new Gtk.Box({ cssClasses: ['card'], marginTop: 2 });
        bubble.append(label);
        label.set_margin_top(8);
        label.set_margin_bottom(8);
        label.set_margin_start(12);
        label.set_margin_end(12);
        const align = new Gtk.Box({ halign: mine ? Gtk.Align.END : Gtk.Align.START });
        align.set_hexpand(true);
        bubble.set_hexpand(false);
        align.append(bubble);
        this._messages.append(align);
        this.scrollToEnd();
    }

    /** Render one intake proposal as an APPROVE card — the write happens only on „Übernehmen". */
    private appendProposal(p: EstIntakeProposal): void {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            cssClasses: ['card'],
        });
        card.set_margin_top(4);
        const pad = (w: Gtk.Widget) => {
            w.set_margin_start(12);
            w.set_margin_end(12);
        };
        const title = new Gtk.Label({
            label: `Vorschlag · ${p.titel}`,
            xalign: 0,
            wrap: true,
            cssClasses: ['heading'],
        });
        title.set_margin_top(10);
        pad(title);
        const erg = new Gtk.Label({ label: p.vorschau.ergebnis, xalign: 0, wrap: true, cssClasses: ['title-4'] });
        pad(erg);
        card.append(title);
        card.append(erg);
        for (const h of p.vorschau.hinweise) {
            const hint = new Gtk.Label({
                label: `• ${h}`,
                xalign: 0,
                wrap: true,
                cssClasses: ['dim-label', 'caption'],
            });
            pad(hint);
            card.append(hint);
        }
        const apply = new Gtk.Button({ label: 'Übernehmen', cssClasses: ['suggested-action'] });
        apply.connect('clicked', () => {
            if (!this.entity) return;
            try {
                const v = applyProposal(p, { entityId: this.entity.id, year: this.year });
                appSession().invalidate(this.entity.id);
                apply.set_sensitive(false);
                apply.set_label('Übernommen ✓');
                showToast(`✓ ${p.titel}: ${v.ergebnis}`);
                this.onApplied?.(); // shell re-reads the est snapshot + reloads the visible view
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err));
            }
        });
        const btnRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, halign: Gtk.Align.END });
        btnRow.set_margin_top(4);
        btnRow.set_margin_bottom(12);
        pad(btnRow);
        btnRow.append(apply);
        card.append(btnRow);
        this._messages.append(card);
        this.scrollToEnd();
    }

    private async onSend(): Promise<void> {
        const question = this._entry.get_text().trim();
        if (!question || this.busy || !this.entity) return;
        this._entry.set_text('');
        this.busy = true;
        // Feed the PRIOR turns back as history (before adding this question), then record both turns.
        const history = [...this.turns];
        this.turns.push({ role: 'user', text: question });
        this.appendBubble(question, true);
        const typing = new Gtk.Label({ label: 'Assistent schreibt …', xalign: 0, cssClasses: ['dim-label'] });
        this._messages.append(typing);
        this.scrollToEnd();
        try {
            const { text: reply, proposals } = await askAssistant(this.entity, this.year, question, history);
            this._messages.remove(typing);
            this.appendBubble(reply, false);
            this.turns.push({ role: 'assistant', text: reply });
            for (const p of proposals) this.appendProposal(p);
        } catch (err) {
            this._messages.remove(typing);
            const msg = new Gtk.Label({
                label: err instanceof Error ? err.message : String(err),
                xalign: 0,
                wrap: true,
                cssClasses: ['error'],
            });
            this._messages.append(msg);
        } finally {
            this.busy = false;
        }
    }

    /** Seed a demo conversation + a §24b proposal card (STEUER_APP_ASSIST_DEMO) — for GUI screenshots. */
    private seedDemo(): void {
        this.appendBubble('Ich war ab November alleinerziehend mit meinem Sohn.', true);
        this.appendBubble(
            'Alles klar. Dann steht dir der Entlastungsbetrag für Alleinerziehende (§24b) anteilig für November und Dezember zu. Hier mein Vorschlag zum Übernehmen:',
            false,
        );
        const p = buildProposal(
            'entlastung',
            { alleinstehendMitKind: true, von: `${this.year}-11`, kindIdnr: '00000000000' },
            { entityId: this.entity?.id ?? 'privat', year: this.year },
        );
        if (p) this.appendProposal(p);
    }

    private scrollToEnd(): void {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const adj = this._scroller.get_vadjustment();
            if (adj) adj.set_value(adj.get_upper());
            return GLib.SOURCE_REMOVE;
        });
    }
}
