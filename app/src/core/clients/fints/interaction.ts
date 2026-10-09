/**
 * The TAN/PIN seam — how a bank's question reaches whoever is sitting in front of the program.
 *
 * A FinTS session is interactive by law: the bank interrupts with a TAN challenge, or waits for a
 * push confirmation in the banking app, and the client cannot continue until a human answers. That
 * conversation was hardwired to the terminal — `readline` on stdin, progress on stderr — which made
 * the whole FinTS path CLI-only. The native app can configure a bank account and then never
 * complete a single sync: the first challenge blocks on a stdin nobody is typing into, and the
 * error the user eventually sees names `fints sync --account …`, a command line.
 *
 * So the conversation becomes a registered provider. The CLI keeps its terminal prompt, the app
 * shows a dialog, and MCP registers nothing — which is correct, because an agent must not be able
 * to answer a TAN challenge on the user's behalf.
 *
 * The default provider REFUSES rather than reading stdin: a surface that forgot to register would
 * otherwise hang forever on an invisible prompt, and a hang is the one failure nobody can debug.
 */

/** A TAN challenge from the bank, as far as the user needs to see it. */
export interface TanRequest {
    /** Configured account name, so a dialog can say which bank is asking. */
    accountName: string;
    /** The bank's own challenge text, when it sent one. */
    challenge?: string;
    /** Name of the selected TAN method (`pushTAN`, `chipTAN`, …), when known. */
    method?: string;
}

/** A request for the online-banking PIN, used only when none is stored. */
export interface PinRequest {
    accountName: string;
    blz: string;
}

/**
 * What a surface must supply so a FinTS session can talk to the user.
 *
 * `notify` is progress, not a question: decoupled methods (push confirmation in the banking app)
 * poll for up to several minutes, and a UI that says nothing during that looks frozen.
 */
export interface FinTSInteraction {
    requestTan(request: TanRequest): Promise<string>;
    requestPin(request: PinRequest): Promise<string>;
    notify(message: string): void;
}

class NoInteraction implements FinTSInteraction {
    private refuse(what: string): never {
        throw new Error(
            `${what} — dieser Zugang kann keine Rückfragen der Bank beantworten. ` +
                'FinTS braucht eine TAN-Eingabe; die gibt es in der App und im Terminal, nicht hier.',
        );
    }
    requestTan(): Promise<string> {
        this.refuse('Keine TAN-Eingabe angeschlossen');
    }
    requestPin(): Promise<string> {
        this.refuse('Keine PIN-Eingabe angeschlossen');
    }
    notify(message: string): void {
        console.error(`[fints] ${message}`);
    }
}

/**
 * A provider that refuses every question — the default, and what a surface with no human at the
 * other end (the MCP server) registers deliberately.
 */
export function refusingFinTSInteraction(): FinTSInteraction {
    return new NoInteraction();
}

let current: FinTSInteraction = refusingFinTSInteraction();

/**
 * Register the surface's way of asking. Call once at process start, before any sync.
 * Returns the previous provider so a test can restore it.
 */
export function setFinTSInteraction(interaction: FinTSInteraction): FinTSInteraction {
    const previous = current;
    current = interaction;
    return previous;
}

/** The registered provider — the refusing default until a surface registers its own. */
export function finTSInteraction(): FinTSInteraction {
    return current;
}
