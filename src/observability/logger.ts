/**
 * Structured, content-free logger.
 *
 * HARD RULE: transport logs never contain credentials, passwords, message
 * bodies, attachment bytes, raw MIME, auth headers, connection strings, or key
 * material. This logger accepts only a small, typed field bag and additionally
 * runs a defensive redactor that drops known-sensitive keys and truncates long
 * strings — so even an accidental field cannot leak content.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Keys that must never be emitted. Matched case-insensitively as a substring so
 * `imapPassword`, `smtp_pass`, `authorization`, `body_html` etc. are all caught.
 */
const FORBIDDEN_KEY_SUBSTRINGS = [
  "password",
  "passwd",
  "pass",
  "secret",
  "token",
  "credential",
  "ciphertext",
  "plaintext",
  "nonce",
  "authtag",
  "auth_tag",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "key",
  "body",
  "html",
  "text_body",
  "mime",
  "raw",
  "attachmentdata",
  "connectionstring",
  "connection_string",
  "dsn",
];

const MAX_VALUE_LEN = 256;

export interface Logger {
  child(bindings: LogFields): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

function isForbiddenKey(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN_KEY_SUBSTRINGS.some((bad) => k.includes(bad));
}

/** Defensive redaction: drop forbidden keys, truncate long strings. */
export function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isForbiddenKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > MAX_VALUE_LEN) {
      out[key] = `${value.slice(0, MAX_VALUE_LEN)}…[truncated]`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface LoggerSink {
  write(line: string): void;
}

export class JsonLogger implements Logger {
  private readonly min: number;
  private readonly bindings: LogFields;
  private readonly sink: LoggerSink;
  private readonly clockNow: () => string;

  public constructor(options: {
    level: LogLevel;
    bindings?: LogFields;
    sink?: LoggerSink;
    now?: () => string;
  }) {
    this.min = LEVEL_ORDER[options.level];
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? {
      write: (line): void => {
        process.stdout.write(line + "\n");
      },
    };
    this.clockNow = options.now ?? ((): string => new Date().toISOString());
  }

  public child(bindings: LogFields): Logger {
    return new JsonLogger({
      level: levelFromOrder(this.min),
      bindings: { ...this.bindings, ...redactFields(bindings) },
      sink: this.sink,
      now: this.clockNow,
    });
  }

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.min) return;
    const record = {
      ts: this.clockNow(),
      level,
      msg,
      ...this.bindings,
      ...redactFields(fields ?? {}),
    };
    this.sink.write(JSON.stringify(record));
  }

  public debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  public info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  public warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  public error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }
}

function levelFromOrder(order: number): LogLevel {
  for (const [name, value] of Object.entries(LEVEL_ORDER)) {
    if (value === order) return name as LogLevel;
  }
  return "info";
}
