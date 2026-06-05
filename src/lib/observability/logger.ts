/**
 * Structured logging helper (Phase 7 observability).
 *
 * Emits single-line JSON to stdout/stderr so logs are machine-parseable in any
 * log aggregator (Vercel, Datadog, etc.) with NO configuration and NO env vars.
 * A `requestId`/`traceId` can be threaded through via {@link childLogger} so
 * every line for one request shares a correlation id.
 *
 * Design rules (match the rest of the codebase):
 *  - No env reads at module load. `LOG_LEVEL` is consulted lazily, defaults to
 *    `info`, and an unset/invalid value never throws.
 *  - Pure + side-effect-free except for the final `console.*` write, so it is
 *    safe to import anywhere (server routes, domain layer).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Resolve the active minimum level from env, lazily; defaults to `info`. */
export function activeLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export type LogFields = Record<string, unknown>;

export interface LogRecord extends LogFields {
  level: LogLevel;
  msg: string;
  time: string;
}

/**
 * Build the structured record for a log line. Exposed (and pure) so tests can
 * assert the shape without capturing console output.
 */
export function buildRecord(
  level: LogLevel,
  msg: string,
  fields: LogFields = {},
): LogRecord {
  return {
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  };
}

/** Whether a record at `level` should be emitted given the active level. */
export function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[activeLevel()];
}

function write(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps `bound` fields on every line. */
  child(bound: LogFields): Logger;
}

function make(bound: LogFields): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (!shouldLog(level)) return;
    write(buildRecord(level, msg, { ...bound, ...fields }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (more) => make({ ...bound, ...more }),
  };
}

/** The root logger. Use `logger.child({ requestId })` per request. */
export const logger: Logger = make({});

/** Create a request/trace-scoped child logger. */
export function childLogger(fields: LogFields): Logger {
  return logger.child(fields);
}
