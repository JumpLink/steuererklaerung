/**
 * Belege aus einem Mail-Ordner (schema v24, the `mail_eingang_state` table): the cursor of one entity's
 * fetch. IMAP numbers messages per folder with a UID that is only meaningful together with the folder's
 * UIDVALIDITY — when the server reports another one, every stored UID is void.
 */
export interface MailEingangState {
  entityId: string;
  folder: string;
  /** UIDVALIDITY of the folder when `lastUid` was stored; null before the first run. */
  uidValidity: number | null;
  /** Highest UID that was fully processed (0 = nothing yet). */
  lastUid: number;
  /** ISO timestamp of the last run, with or without result. */
  lastRunAt: string | null;
  /** The one-line German result of the last run (counts only, no sender or subject). */
  lastResult: string | null;
}
