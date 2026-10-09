/**
 * General file logger: append-only log with timestamp and level.
 * Use from any part of the app (sync, future commands, etc.).
 * Path: for named loggers use LOG_FILE_<NAME> (e.g. LOG_FILE_SYNC_IMPORT) or cwd/<name>.log;
 * for default logger use LOG_FILE or cwd/app.log.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_APP_LOG = 'app.log';

function getLogPath(name?: string): string {
  if (name) {
    const envKey = `LOG_FILE_${name.toUpperCase().replace(/-/g, '_')}`;
    const envPath = process.env[envKey]?.trim();
    if (envPath) return envPath;
    return join(process.cwd(), `${name}.log`);
  }
  const envPath = process.env.LOG_FILE?.trim();
  if (envPath) return envPath;
  return join(process.cwd(), DEFAULT_APP_LOG);
}

function timestamp(): string {
  return new Date().toISOString();
}

function write(path: string, level: string, message: string, stack?: string): void {
  const line = `[${timestamp()}] ${level}: ${message}\n`;
  try {
    appendFileSync(path, line, 'utf-8');
    if (stack) {
      appendFileSync(path, stack + '\n', 'utf-8');
    }
  } catch {
    // Avoid breaking the app if log file is not writable
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

/** Cache to avoid creating a new logger object on every call. */
const loggerCache = new Map<string, Logger>();

/**
 * Return a logger that writes to a file. Use a name for a dedicated log (e.g. 'sync-import' → sync-import.log)
 * or omit for the default app log (app.log). Override path via LOG_FILE or LOG_FILE_<NAME>.
 *
 * Logger instances are cached by name.
 */
export function getLogger(name?: string): Logger {
  const key = name ?? '__default__';
  let logger = loggerCache.get(key);
  if (logger) return logger;

  const path = getLogPath(name);
  logger = {
    info(message: string): void {
      write(path, 'INFO', message);
    },
    warn(message: string): void {
      write(path, 'WARN', message);
    },
    error(message: string, err?: unknown): void {
      const stack = err instanceof Error ? err.stack : undefined;
      write(path, 'ERROR', message, stack);
    },
  };
  loggerCache.set(key, logger);
  return logger;
}
