/**
 * BhLotsePanel — the side panel that holds a coding agent instead of the in-process assistant.
 *
 * The second of two assistant panes. `BhAssistentPanel` calls an LLM provider in-process and can
 * propose writes into the person's ESt data; this one embeds lotse's `LotseChat`, which starts
 * **opencode as a subprocess** over ACP and reaches this app only through this app's own MCP
 * server. Which of the two the window builds is `aiEngine` (Settings → Allgemein), and whether it
 * builds either at all is the AI opt-in.
 *
 * **Nothing happens until the panel is constructed, and it is only constructed from a plan.** Every
 * decision — is AI on, is this the chosen engine, where may it write, which servers does it get,
 * what does the gate refuse — lives in `core/actions/assistant/lotse-embed.ts` and is testable
 * without a display. This file is the surface: it builds the chat, fills the host's own no-agent
 * page from lotse's sentences, and hands `shutdown()` to the window.
 *
 * Three things here are policy rather than chrome:
 *   - `modelPolicy` — `plan.modelPolicy` (`LOTSE_MODEL_POLICY`), so no free hosted model can answer
 *     a prompt from this pane. Receipts, bookings and Steuernummern are reachable through the MCP
 *     server here, and they do not belong in a free hosted model's context. The widget hides those
 *     models and refuses the prompt while one is selected; it never switches models for the person.
 *   - `providerOnboarding: true` — with no provider connected, the pane offers lotse's login dialog
 *     for every provider lotse supports (ADR 0002: one login, in the widget). The policy above
 *     still refuses a free hosted model whichever provider serves it. lotse stores no credential and
 *     this panel reads none; the login lives in the agent's own store.
 *   - `gate` — `assistantGateAnswer` declines the destructive tool kinds and asks about the rest.
 *     It sees tool calls only; it cannot see which model answers, which is why the model policy is
 *     a separate mechanism and not a claim about the gate.
 *
 * GJS-GUI → headless not verifiable (Sandbox Exit 144); build-verified. The wiring underneath is
 * covered by `tests/unit/assistant/lotse-embed.test.ts` on both runtimes.
 */

import type Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { DEFAULT_AGENT, emptyStateView, gatherResolveContext, requireLauncher, resolveRecorded } from '@lotse/core';
import { createSessionStore } from '@lotse/session';
import { LotseChat } from '@lotse/widget';

import {
    assistantGateAnswer,
    ensureLotseDataRoot,
    resolveLotseAgent,
    type LotseEmbedPlan,
} from '../../core/actions/assistant/lotse-embed.ts';
import Template from './lotse-panel.blp';

export class BhLotsePanel extends Gtk.Box {
    /** Called by the window to hide the panel (the header toggle owns the state). */
    onClose: (() => void) | null = null;

    private chat: LotseChat | null = null;

    declare private _chat_bin: Gtk.Box;
    declare private _no_agent_page: Adw.StatusPage;
    declare private _no_agent_command: Gtk.Label;
    declare private _no_agent_docs: Gtk.LinkButton;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhLotsePanel',
                Template,
                InternalChildren: ['chat_bin', 'no_agent_page', 'no_agent_command', 'no_agent_docs'],
            },
            this,
        );
    }

    /** Template handler for the close button. The window owns the visibility. */
    private _onCloseClicked(): void {
        this.onClose?.();
    }

    /**
     * Build the chat for a plan. Separate from the constructor because `GObject.registerClass`
     * owns the latter, and because a plan is the only thing that may produce a chat.
     *
     * `gatherResolveContext(paths, false)` — no `--version` spawn, so the pane appears without
     * waiting on a child process, exactly as lotse's own window does it.
     */
    build(plan: LotseEmbedPlan): void {
        ensureLotseDataRoot(plan.dataRoot);
        const store = createSessionStore(plan.paths.sessionsFile);
        const { agent, note } = resolveLotseAgent(plan.paths);
        const empty = emptyStateView({ agent });
        if (empty.kind === 'no-agent') {
            this._no_agent_page.set_title(empty.title);
            this._no_agent_page.set_description(empty.body);
            this._no_agent_command.set_label(empty.commands.join('\n'));
            this._no_agent_docs.set_uri(empty.docsUrl);
        }
        if (note) console.error(`[lotse] ${note}`);

        const chat = new LotseChat({
            // A command is required even when nothing resolved; `noAgent` then switches Send off.
            agent: agent?.command ?? requireLauncher(DEFAULT_AGENT),
            agentSource: agent?.source ?? 'host',
            newChat: { cwd: plan.cwd, home: GLib.get_home_dir() },
            createSession: (record) => store.create(record),
            appendTurns: (id, entries) => store.append(id, entries),
            resolveAgent: async (id, source) =>
                resolveRecorded(id, source, gatherResolveContext(plan.paths, false, false)),
            mcpServers: plan.mcpServers,
            modelPolicy: plan.modelPolicy,
            ...(empty.kind === 'no-agent' ? { noAgent: empty } : {}),
            noAgentPage: this._no_agent_page,
            providerOnboarding: true,
            gate: (question) => assistantGateAnswer(question.view),
            onNotice: (message) => console.error(`[lotse] ${message}`),
        });
        chat.set_vexpand(true);
        this._chat_bin.append(chat);
        this.chat = chat;
        chat.newChat();
    }

    /**
     * Stop the agent subprocess. The window blocks its close on this: a pane torn down while a
     * child is mid-turn leaves the child behind, and that child holds a read-only MCP server onto
     * this person's bookkeeping. Safe to call when nothing was ever built.
     */
    async shutdown(): Promise<void> {
        await this.chat?.shutdown();
    }
}
