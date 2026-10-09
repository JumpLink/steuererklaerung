/**
 * Domain-specific error classes for consistent error handling.
 * Replaces ad-hoc Error throws and string-based error matching throughout the codebase.
 *
 * Note: No TypeScript parameter properties (public readonly in constructor) — Node 22
 * --experimental-strip-types does not support them.
 */

/** Hint shown when config IDs are missing; use in error messages. */
export const SETUP_HINT = 'Run "paperless setup-fields" to create and register IDs.';

/**
 * Error from an external API (Qonto, Paperless, Scaleway).
 */
export class ApiError extends Error {
  readonly name: string = 'ApiError';
  readonly service: string;
  readonly statusCode: number;
  readonly body: string;

  constructor(service: string, statusCode: number, body: string, message: string) {
    super(message);
    this.service = service;
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Configuration error: missing config file, invalid values, etc.
 */
export class ConfigError extends Error {
  // Typed as string, not the literal, so subclasses can name themselves — same as ApiError above.
  readonly name: string = 'ConfigError';
  readonly configPath?: string;

  constructor(message: string, configPath?: string) {
    super(message);
    this.configPath = configPath;
  }
}

/**
 * Paperless resources (document types, custom fields, tags) are not registered yet.
 *
 * A distinct TYPE rather than a message every frontend has to re-match: the remedy differs per
 * surface — the CLI names its command, the app has a button that performs the setup — and a hint
 * baked into the message means the GUI shows the user a command line, which is a dead end. Keeping
 * SETUP_HINT in the message leaves CLI output unchanged; `isPaperlessSetupRequired` is what a GUI
 * asks instead of grepping the string.
 */
export class PaperlessSetupError extends ConfigError {
  override readonly name = 'PaperlessSetupError';
  /** Which sync-config fields were missing, so each surface can word its own message. */
  readonly fields: string[];

  constructor(message: string, fields: string[]) {
    super(message);
    this.fields = fields;
  }
}

/**
 * A capability that exists, but not for the back-end this entity is on.
 *
 * The USt-VA aggregate reads receipts from Paperless and only from Paperless. On an entity using
 * the built-in DMS it therefore failed with a Paperless *config* error — which tells the user to go
 * fix Paperless, a thing they are deliberately not using. Naming the real condition is the point:
 * a wrong diagnosis costs more than a missing one.
 */
export class DmsUnsupportedError extends ConfigError {
  override readonly name = 'DmsUnsupportedError';
  /** The back-end the entity is on. */
  readonly dmsType: string;
  /** Which capability is unavailable there, in the user's words. */
  readonly capability: string;

  constructor(capability: string, dmsType: string, message: string) {
    super(message);
    this.capability = capability;
    this.dmsType = dmsType;
  }
}

/**
 * There is no manifest yet — the FIRST-RUN condition, not a failure.
 *
 * On a fresh installation it is the normal state of the world, and the remedy is the setup
 * assistant, not the `steuer config migrate` the message names for a terminal. Measured on a real
 * package install: the assistant opened correctly, and behind it the Übersicht showed the CLI
 * command as its whole explanation.
 */
export class ManifestMissingError extends ConfigError {
  override readonly name = 'ManifestMissingError';
}

/** Whether an unknown thrown value is the "no manifest yet" condition. */
export function isManifestMissing(err: unknown): err is ManifestMissingError {
  return err instanceof ManifestMissingError;
}

/** Whether an unknown thrown value is the "not available on this DMS back-end" condition. */
export function isDmsUnsupported(err: unknown): err is DmsUnsupportedError {
  return err instanceof DmsUnsupportedError;
}

/** Whether an unknown thrown value is the "Paperless not set up yet" condition. */
export function isPaperlessSetupRequired(err: unknown): err is PaperlessSetupError {
  return err instanceof PaperlessSetupError;
}

/**
 * Throw a ConfigError for a missing or invalid sync-config field.
 */
export function configMissingError(field: string): never {
  throw new PaperlessSetupError(`${field} not set in sync-config.json. ${SETUP_HINT}`, field.split(' / '));
}
