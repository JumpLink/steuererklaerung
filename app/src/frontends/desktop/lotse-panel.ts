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
 *   - No `modelPolicy` (issue #95): a free hosted model may answer, and lotse's warning card above
 *     the message field says where the text goes while one is selected. Background jobs keep the
 *     hard block (`LOTSE_MODEL_POLICY`), because nobody is there to read a card.
 *   - `providerOnboarding: true` — with no provider connected, the pane offers lotse's login dialog
 *     for every provider lotse supports (ADR 0002: one login, in the widget). lotse stores no
 *     credential and this panel reads none; the login lives in the agent's own store.
 *   - `gate` — `assistantGateAnswer` declines the destructive tool kinds and asks about the rest.
 *     It sees tool calls only; it cannot see which model answers.
 *
 * GJS-GUI → headless not verifiable (Sandbox Exit 144); build-verified. The wiring underneath is
 * covered by `tests/unit/assistant/lotse-embed.test.ts` on both runtimes.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import { DEFAULT_AGENT, emptyStateView, gatherResolveContext, requireLauncher, resolveRecorded } from '@lotse/core';
import { createSessionStore } from '@lotse/session';
import { LotseChat } from '@lotse/widget';

import {
    agentInstallOffer,
    assistantGateAnswer,
    ensureLotseDataRoot,
    installOfferedAgent,
    resolveLotseAgent,
    type AgentInstallOffer,
    type LotseEmbedPlan,
} from '../../core/actions/assistant/lotse-embed.ts';
import { _, fmt } from './i18n.ts';
import Template from './lotse-panel.blp';

export class BhLotsePanel extends Gtk.Box {
    /** Called by the window to hide the panel (the header toggle owns the state). */
    onClose: (() => void) | null = null;

    private chat: LotseChat | null = null;
    private plan: LotseEmbedPlan | null = null;
    private offer: AgentInstallOffer | null = null;

    declare private _chat_bin: Gtk.Box;
    declare private _no_agent_page: Adw.StatusPage;
    declare private _no_agent_command: Gtk.Label;
    declare private _no_agent_docs: Gtk.LinkButton;
    declare private _no_agent_install: Gtk.Button;
    declare private _no_agent_install_status: Gtk.Label;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhLotsePanel',
                Template,
                InternalChildren: [
                    'chat_bin',
                    'no_agent_page',
                    'no_agent_command',
                    'no_agent_docs',
                    'no_agent_install',
                    'no_agent_install_status',
                ],
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
        this.plan = plan;
        this.mountChat(plan);
    }

    /** Template handler for the install button on the "no agent" page. */
    private _onInstallClicked(): void {
        this.installOffered().catch((err) => console.error(`[app] ${err}`));
    }

    /**
     * Ask, download, resolve again. The download is a program fetched from the network, so the
     * person confirms first (size and source named); nothing is fetched on its own. On success the
     * chat is built anew — `resolveLotseAgent` now finds the per-user copy — on failure lotse's
     * sentence stays on the page and the button works again.
     */
    private async installOffered(): Promise<void> {
        const plan = this.plan;
        const offer = this.offer;
        const window = this.get_root();
        if (!plan || !offer || !(window instanceof Gtk.Window)) return;

        const dialog = new Adw.AlertDialog({
            heading: fmt(_('Download {agent}?'), { agent: offer.agent.title }),
            body: fmt(
                _(
                    '{agent} {version} ({size} MB) is downloaded from registry.npmjs.org, checked against a fixed checksum and stored in this app’s own data folder. Nothing outside it is changed.',
                ),
                { agent: offer.agent.title, version: offer.agent.version, size: offer.megabytes },
            ),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('download', _('Download'));
        dialog.set_default_response('download');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('download', Adw.ResponseAppearance.SUGGESTED);
        const response = await new Promise<string>((resolve) => {
            dialog.connect('response', (_d: Adw.AlertDialog, answer: string) => resolve(answer));
            dialog.present(window);
        });
        if (response !== 'download') return;

        this._no_agent_install.set_sensitive(false);
        this._no_agent_install_status.set_label(fmt(_('Downloading {agent}…'), { agent: offer.agent.title }));
        this._no_agent_install_status.set_visible(true);
        const failure = await installOfferedAgent(offer, plan.paths);
        if (failure !== null) {
            this._no_agent_install_status.set_label(failure);
            this._no_agent_install.set_sensitive(true);
            return;
        }
        await this.remountChat(plan);
    }

    /** Replace the chat with a fresh one built from the same plan. */
    private async remountChat(plan: LotseEmbedPlan): Promise<void> {
        const old = this.chat;
        this.chat = null;
        if (old) {
            await old.shutdown();
            this._chat_bin.remove(old);
        }
        // The page is parented into the old chat's slot; free it for the new one.
        const holder = this._no_agent_page.get_parent();
        if (holder instanceof Adw.Bin) holder.set_child(null);
        this.mountChat(plan);
    }

    private mountChat(plan: LotseEmbedPlan): void {
        const store = createSessionStore(plan.paths.sessionsFile);
        const { agent, note } = resolveLotseAgent(plan.paths);
        const empty = emptyStateView({ agent });
        this.offer = null;
        if (empty.kind === 'no-agent') {
            this._no_agent_page.set_title(empty.title);
            this._no_agent_page.set_description(empty.body);
            this._no_agent_command.set_label(empty.commands.join('\n'));
            this._no_agent_docs.set_uri(empty.docsUrl);
            this.offer = agentInstallOffer(plan.paths);
        }
        this._no_agent_install.set_visible(this.offer !== null);
        this._no_agent_install.set_sensitive(true);
        this._no_agent_install_status.set_visible(false);
        if (this.offer) {
            this._no_agent_install.set_label(
                fmt(_('Install {agent} ({size} MB)'), { agent: this.offer.agent.title, size: this.offer.megabytes }),
            );
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
