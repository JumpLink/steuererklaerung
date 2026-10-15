/**
 * Acknowledgement of the tax administration's privacy notice — the licence duty before the first
 * ELSTER send.
 *
 * The ERiC licence (§ 5) makes the software vendor show the end user the Datenschutzschreiben and
 * a short privacy notice, with a chance to read them and to confirm having read them, BEFORE the
 * software is used. The app shows both ahead of the first send (test or live) and keeps the
 * confirmation here, per user and machine — not in the manifest, which is shared between
 * machines and entities, while the duty is about the person at this keyboard.
 *
 * The record carries the notice version: if the text ever changes, bump {@link PRIVACY_NOTICE_VERSION}
 * and everybody confirms once more.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { _ } from '../../lib/i18n.ts';
import { userDataDir } from '../../paths.ts';

/** Version of the privacy notice texts the user confirms. */
export const PRIVACY_NOTICE_VERSION = 1;

const FILE_NAME = 'elster-datenschutz.json';

/** What is stored once the notice was confirmed. */
export interface PrivacyAck {
    version: number;
    /** ISO timestamp of the confirmation. */
    acknowledgedAt: string;
}

/** Where the confirmation lives (overridable for tests). */
export function privacyAckPath(dataDir: string = userDataDir()): string {
    return join(dataDir, FILE_NAME);
}

/** The stored confirmation, or null when none exists, it is unreadable, or it is for an older text. */
export function readPrivacyAck(dataDir?: string): PrivacyAck | null {
    const file = privacyAckPath(dataDir);
    if (!existsSync(file)) return null;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PrivacyAck>;
        if (parsed.version !== PRIVACY_NOTICE_VERSION || typeof parsed.acknowledgedAt !== 'string') return null;
        return { version: parsed.version, acknowledgedAt: parsed.acknowledgedAt };
    } catch {
        return null;
    }
}

/** Whether the current notice version was confirmed on this machine. */
export function isPrivacyAcknowledged(dataDir?: string): boolean {
    return readPrivacyAck(dataDir) !== null;
}

/** Record the confirmation of the current notice version. */
export function acknowledgePrivacy(dataDir?: string, now: Date = new Date()): PrivacyAck {
    const ack: PrivacyAck = { version: PRIVACY_NOTICE_VERSION, acknowledgedAt: now.toISOString() };
    const file = privacyAckPath(dataDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(ack, null, 2)}\n`);
    return ack;
}

/**
 * The privacy notice the licence (§ 5 Abs. 2) prescribes. The German catalogue carries the
 * administration's wording VERBATIM; the English msgid is a translation for the source language.
 * Built on call, not at module level (see lib/i18n.ts).
 */
export function privacyNoticeText(): string {
    return _(
        'Privacy notice of the tax administration:\n"With this software, personal data within the meaning of Art. 4 No. 1 GDPR and Art. 9 (1) GDPR are collected for processing. Besides the data needed for the tax assessment, the software collects data about the type of operating system of the user and transmits it to the tax administration. This data is needed to ensure correct processing and to prevent errors in the processing. The data is used by the tax administration within the scope of Art. 6 (1) subpara. 1 point (e) in conjunction with (3) subpara. 1 point (b) GDPR in conjunction with federal and state tax laws, and only for the stated purpose."',
    );
}

/** The log-file notice the licence (§ 15) prescribes; {path} is where ERiC writes them. */
export function logFileNoticeText(): string {
    return _(
        'ERiC writes log files while it works. They are stored locally on this computer, in {path}, and stay here. They are only passed on to the software vendor in a support case, and only with your explicit permission.',
    );
}
