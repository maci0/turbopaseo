// Proof-only stand-in for pino: pino 9 does not load in a scriptc 0.4.10 binary (atomic-sleep
// replaces module.exports conditionally). Warnings and errors go to stderr; the rest is dropped.
export interface Logger {
  level: string;
  child(bindings: Record<string, unknown>): Logger;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

class StubLogger implements Logger {
  level: string;
  constructor(level: string) {
    this.level = level;
  }
  child(_bindings: Record<string, unknown>): Logger {
    return new StubLogger(this.level);
  }
  trace(..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(...args: unknown[]): void {
    this.write("warn", args);
  }
  error(...args: unknown[]): void {
    this.write("error", args);
  }
  fatal(...args: unknown[]): void {
    this.write("fatal", args);
  }
  private write(level: string, args: unknown[]): void {
    if (this.level === "silent") return;
    const text = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    process.stderr.write(`[${level}] ${text}\n`);
  }
}

function pino(options?: { level?: string }): Logger {
  return new StubLogger(options?.level ?? "info");
}

declare namespace pino {
  type Logger = import("./pino-stub.js").Logger;
}

export default pino;
