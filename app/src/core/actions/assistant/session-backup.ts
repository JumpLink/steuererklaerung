/**
 * One backup before the first change of an assistant session (ADR 0005).
 *
 * The first write of a session takes a snapshot and waits for it; every later write of the same
 * session rides on it, so a conversation with forty writes costs one backup folder. A failed
 * snapshot is remembered: the session's writes stay declined, with no "proceed once without" — the
 * way out is switching the assistant off, because a write the person cannot get back is exactly
 * what the snapshot is for.
 */

export class SessionBackupError extends Error {
    constructor(cause: unknown) {
        const why = cause instanceof Error ? cause.message : String(cause);
        super(
            `No change was made: the backup that must precede an assistant's first change failed (${why}). ` +
                'Writes stay blocked for this session; switch the assistant off or fix the backup and start a new session.',
        );
        this.name = 'SessionBackupError';
    }
}

export class SessionBackupGate {
    /** `true` = snapshot taken; an error = the one that blocks the session. */
    private readonly sessions = new Map<string, true | SessionBackupError>();

    /** `backup` runs synchronously: the write waits for it. */
    constructor(private readonly backup: () => void) {}

    /** Returns when the session may write; throws {@link SessionBackupError} when it may not. */
    ensure(session: string): void {
        const known = this.sessions.get(session);
        if (known === true) return;
        if (known) throw known;
        try {
            this.backup();
        } catch (err) {
            const blocked = new SessionBackupError(err);
            this.sessions.set(session, blocked);
            throw blocked;
        }
        this.sessions.set(session, true);
    }
}
