// Stand-in for npm pino 10.3.1 in scriptc builds: the subset Paseo uses, writing the same
// JSON lines. See README.md for the surface, the differences and how it is verified.
import { fsyncSync, openSync, write as fsWrite, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";

export type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";
export type LevelWithSilent = Level | "silent";
export type Bindings = Record<string, unknown>;

export interface RedactOptions {
  paths: string[];
  // Only `remove: true` is implemented; the native build refuses a censor.
  remove: true;
}

export interface LoggerOptions {
  level?: string;
  redact?: RedactOptions;
}

export interface DestinationOptions {
  dest: string | number;
  // Writes are always asynchronous, as with sonic-boom { sync: false }.
  sync: false;
}

type RecordValue = Record<string, unknown>;
type LineFormatter = (line: string) => string | undefined;
// A top-level redactor: returns the serialized value, or undefined to drop the key.
type Redactor = (value: unknown) => string | undefined;

const LEVEL_VALUES: Record<LevelWithSilent, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

// sonic-boom's retry delay after EAGAIN/EBUSY.
const BUSY_WRITE_TIMEOUT_MS = 100;
// safe-stable-stringify limits pino configures (depthLimit, edgeLimit).
const MAXIMUM_DEPTH = 5;
const MAXIMUM_BREADTH = 100;
// pino-std-serializers folds an error-like `cause` into message and stack instead of a field.
const CAUSE_KEY = "cause";
// pino's asChindings skips these binding keys (only checked for keys of length 5 or more).
const RESERVED_BINDING_KEYS = new Set(["level", "serializers", "formatters", "customLevels"]);
const BINDING_KEY_CHECK_MIN_LENGTH = 5;
// pino's redaction path tokenizer.
const REDACT_PATH_SEGMENT = /[^.[\]]+|\[([^[\]]*?)\]/g;
const QUOTED_SEGMENT = /^(?:"|'|`)(.*)(?:"|'|`)$/;
// "%", which starts a quick-format directive.
const PERCENT = 37;

const PID_AND_HOSTNAME = `,"pid":${process.pid},"hostname":${JSON.stringify(osHostname())}`;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Destination: sonic-boom with { sync: false } as pino.destination() builds it.

export class Destination {
  private pending = "";
  private writing = false;
  private broken = false;

  constructor(
    private readonly fd: number,
    private readonly format: LineFormatter | null,
  ) {
    process.on("exit", () => {
      this.flushSync();
    });
  }

  write(line: string): void {
    if (this.broken) {
      return;
    }
    const data = this.format === null ? line : this.format(line);
    if (data === undefined) {
      return;
    }
    this.pending += data;
    if (!this.writing) {
      this.startWrite();
    }
  }

  flushSync(): void {
    if (this.broken || this.pending.length === 0) {
      return;
    }
    let buffer = Buffer.from(this.pending);
    this.pending = "";
    while (buffer.length > 0) {
      try {
        buffer = buffer.subarray(writeSync(this.fd, buffer));
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EAGAIN" && code !== "EBUSY") {
          throw error;
        }
        sleepSync(BUSY_WRITE_TIMEOUT_MS);
      }
    }
    try {
      fsyncSync(this.fd);
    } catch {
      // Same as sonic-boom: the fd might not support fsync.
    }
  }

  private startWrite(): void {
    this.writing = true;
    const buffer = Buffer.from(this.pending);
    this.pending = "";
    this.writeBuffer(buffer);
  }

  private writeBuffer(buffer: Buffer): void {
    fsWrite(this.fd, buffer, 0, buffer.length, null, (error, written) => {
      if (error) {
        if (error.code === "EAGAIN" || error.code === "EBUSY") {
          setTimeout(() => this.writeBuffer(buffer), BUSY_WRITE_TIMEOUT_MS);
          return;
        }
        if (error.code === "EPIPE") {
          // pino stops logging to a destination whose reader went away.
          this.broken = true;
          this.pending = "";
          this.writing = false;
          return;
        }
        // pino re-emits the error on the stream, where nothing listens: it is thrown.
        throw error;
      }
      if (written < buffer.length) {
        this.writeBuffer(buffer.subarray(written));
      } else if (this.pending.length > 0) {
        this.startWrite();
      } else {
        this.writing = false;
      }
    });
  }
}

export function openDestination(dest: string | number, format: LineFormatter | null): Destination {
  return new Destination(typeof dest === "number" ? dest : openSync(dest, "a"), format);
}

// ---------------------------------------------------------------------------
// Serialization: pino's stringify() and safe-stable-stringify's fallback.

function stableKey(key: string): string {
  return JSON.stringify(key);
}

function itemCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

function stringifyFallbackArray(items: unknown[], stack: unknown[]): string {
  if (items.length === 0) {
    return "[]";
  }
  if (MAXIMUM_DEPTH < stack.length + 1) {
    return '"[Array]"';
  }
  stack.push(items);
  const parts: string[] = [];
  const count = Math.min(items.length, MAXIMUM_BREADTH);
  for (let index = 0; index < count; index += 1) {
    parts.push(stringifyFallback(String(index), items[index], stack) ?? "null");
  }
  if (items.length - 1 > MAXIMUM_BREADTH) {
    parts.push(`"... ${itemCount(items.length - MAXIMUM_BREADTH - 1)} not stringified"`);
  }
  stack.pop();
  return `[${parts.join(",")}]`;
}

function stringifyFallbackObject(record: RecordValue, stack: unknown[]): string {
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    return "{}";
  }
  if (MAXIMUM_DEPTH < stack.length + 1) {
    return '"[Object]"';
  }
  stack.push(record);
  const parts: string[] = [];
  const count = Math.min(keys.length, MAXIMUM_BREADTH);
  for (let index = 0; index < count; index += 1) {
    const entryKey = keys[index];
    const entry = stringifyFallback(entryKey, record[entryKey], stack);
    if (entry !== undefined) {
      parts.push(`${stableKey(entryKey)}:${entry}`);
    }
  }
  if (keys.length > MAXIMUM_BREADTH) {
    parts.push(`"...":"${itemCount(keys.length - MAXIMUM_BREADTH)} not stringified"`);
  }
  stack.pop();
  return `{${parts.join(",")}}`;
}

// safe-stable-stringify 2 configured as pino configures it (sorted keys, "[Circular]").
function stringifyFallback(key: string, input: unknown, stack: unknown[]): string | undefined {
  switch (typeof input) {
    case "string":
      return JSON.stringify(input);
    case "number":
      return Number.isFinite(input) ? String(input) : "null";
    case "boolean":
      return input ? "true" : "false";
    case "bigint":
      return String(input);
    default:
      break;
  }
  if (!isRecord(input)) {
    return undefined;
  }
  let value: unknown = input;
  const toJSON = input.toJSON;
  if (typeof toJSON === "function") {
    value = (toJSON as (this: RecordValue, key: string) => unknown).call(input, key);
    if (!isRecord(value)) {
      return stringifyFallback(key, value, stack);
    }
  }
  const record: RecordValue = value as RecordValue;
  if (stack.includes(record)) {
    return '"[Circular]"';
  }
  return Array.isArray(record)
    ? stringifyFallbackArray(record, stack)
    : stringifyFallbackObject(record, stack);
}

// pino's stringify(): JSON.stringify, then safe-stable-stringify for circular or bigint values.
function stringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return stringifyFallback("", value, []);
    } catch {
      return '"[unable to serialize, circular reference is too complex to analyze]"';
    }
  }
}

// ---------------------------------------------------------------------------
// Error serializer: pino-std-serializers 7 err().

function isErrorLike(value: unknown): value is RecordValue {
  return isRecord(value) && typeof value.message === "string";
}

function errorCause(error: RecordValue): RecordValue | undefined {
  const cause = error.cause;
  if (typeof cause === "function") {
    const result: unknown = (cause as (this: RecordValue) => unknown).call(error);
    return isErrorLike(result) ? result : undefined;
  }
  return isErrorLike(cause) ? cause : undefined;
}

function stackWithCauses(error: RecordValue, seen: Set<RecordValue>): string {
  const stack = typeof error.stack === "string" && error.stack !== "" ? error.stack : "";
  if (seen.has(error)) {
    return `${stack}\ncauses have become circular...`;
  }
  const cause = errorCause(error);
  if (!cause) {
    return stack;
  }
  seen.add(error);
  return `${stack}\ncaused by: ${stackWithCauses(cause, seen)}`;
}

function messageWithCauses(error: RecordValue, seen: Set<RecordValue>, skip: boolean): string {
  const ownMessage = error.message;
  let message = "";
  if (!skip && typeof ownMessage === "string") {
    message = ownMessage;
  }
  if (seen.has(error)) {
    return `${message}: ...`;
  }
  const cause = errorCause(error);
  if (!cause) {
    return message;
  }
  seen.add(error);
  const functionCause = typeof error.cause === "function";
  return `${message}${functionCause ? "" : ": "}${messageWithCauses(cause, seen, functionCause)}`;
}

function errorType(error: RecordValue): unknown {
  const constructor: unknown = error.constructor;
  if (typeof constructor === "function") {
    return constructor.name;
  }
  return error.name;
}

// pino's serialized error answers `raw` through an accessor, so err's own `raw` is skipped.
const SERIALIZED_ERROR_RAW_KEY = "raw";

function serializeError(value: unknown, ancestors: Set<RecordValue>): unknown {
  if (!isErrorLike(value)) {
    return value;
  }
  ancestors.add(value);
  const serialized: RecordValue = {
    type: errorType(value),
    message: messageWithCauses(value, new Set(), false),
    stack: stackWithCauses(value, new Set()),
  };
  const errors = value.errors;
  if (Array.isArray(errors)) {
    const items: unknown[] = errors;
    serialized.aggregateErrors = items.map((item) => serializeError(item, ancestors));
  }
  for (const key of Object.keys(value)) {
    if (key === SERIALIZED_ERROR_RAW_KEY || serialized[key] !== undefined) {
      continue;
    }
    const entry = value[key];
    if (isErrorLike(entry)) {
      if (key !== CAUSE_KEY && !ancestors.has(entry)) {
        serialized[key] = serializeError(entry, ancestors);
      }
    } else {
      serialized[key] = entry;
    }
  }
  ancestors.delete(value);
  return serialized;
}

// ---------------------------------------------------------------------------
// Redaction: pino's lib/redaction.js over @pinojs/redact 0.4 with { remove: true }.

function parseRedactPath(path: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inBrackets = false;
  let inQuotes = false;
  let quoteChar = "";
  for (const char of path) {
    if (!inBrackets && char === ".") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else if (char === "[") {
      if (current) {
        parts.push(current);
        current = "";
      }
      inBrackets = true;
    } else if (char === "]" && inBrackets) {
      parts.push(current);
      current = "";
      inBrackets = false;
      inQuotes = false;
    } else if ((char === '"' || char === "'") && inBrackets) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = "";
      } else {
        current += char;
      }
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function cloneForPaths(source: unknown, paths: string[][], depth: number): unknown {
  const keys = new Set<string>();
  for (const parts of paths) {
    if (parts.length > depth) {
      keys.add(parts[depth]);
    }
  }
  if (keys.size === 0 || !isRecord(source)) {
    return source;
  }
  if (source instanceof Date) {
    return new Date(source.getTime());
  }
  const below = (key: string): unknown =>
    cloneForPaths(
      source[key],
      paths.filter((parts) => parts[depth] === key),
      depth + 1,
    );
  if (Array.isArray(source)) {
    const items: unknown[] = source;
    return items.map((item, index) => (keys.has(String(index)) ? below(String(index)) : item));
  }
  const clone: RecordValue = {};
  for (const key of Object.keys(source)) {
    clone[key] = keys.has(key) ? below(key) : source[key];
  }
  return clone;
}

function removePath(target: unknown, parts: string[]): void {
  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!isRecord(current) || !(parts[index] in current)) {
      return;
    }
    current = current[parts[index]];
    if (!isRecord(current)) {
      return;
    }
  }
  const last = parts[parts.length - 1];
  if (isRecord(current) && last in current && hasOwn(current, last)) {
    delete current[last];
  }
}

function pathRemover(paths: string[][]): Redactor {
  return (value: unknown) => {
    const clone = cloneForPaths(value, paths, 0);
    for (const parts of paths) {
      removePath(clone, parts);
    }
    return stringify(clone);
  };
}

interface Redaction {
  byKey: Map<string, Redactor>;
  // Applied to objects interpolated into the message (pino's redactFmtSym redactor).
  all: Redactor;
}

const removeValue: Redactor = () => undefined;

function buildRedaction(options: RedactOptions | undefined): Redaction | null {
  if (options === undefined) {
    return null;
  }
  if (options.remove !== true) {
    throw new Error(
      "pino stand-in: only redact { remove: true } is implemented in the native build",
    );
  }
  const nested = new Map<string, string[][]>();
  const topLevel = new Set<string>();
  for (const path of options.paths) {
    if (path.includes("*")) {
      throw new Error(`pino stand-in: wildcard redaction paths are not implemented (${path})`);
    }
    REDACT_PATH_SEGMENT.lastIndex = 0;
    const first = REDACT_PATH_SEGMENT.exec(path);
    if (first === null) {
      throw new Error(`Invalid redaction path (${path})`);
    }
    const next = REDACT_PATH_SEGMENT.exec(path);
    const ns = first[1] !== undefined ? first[1].replace(QUOTED_SEGMENT, "$1") : first[0];
    if (next === null) {
      topLevel.add(ns);
      nested.delete(ns);
      continue;
    }
    if (topLevel.has(ns)) {
      continue;
    }
    const rest = parseRedactPath(path.substring(next.index));
    const list = nested.get(ns);
    if (list) {
      list.push(rest);
    } else {
      nested.set(ns, [rest]);
    }
  }
  const byKey = new Map<string, Redactor>();
  for (const key of topLevel) {
    byKey.set(key, removeValue);
  }
  for (const [key, paths] of nested) {
    byKey.set(key, pathRemover(paths));
  }
  return { byKey, all: pathRemover(options.paths.map(parseRedactPath)) };
}

// ---------------------------------------------------------------------------
// Message formatting: quick-format-unescaped 4.

// The replacement for one directive, or undefined when quick-format leaves it in place.
function formatDirective(
  directive: string,
  arg: unknown,
  hasArg: boolean,
  serialize: Redactor,
): string | undefined {
  switch (directive) {
    case "d":
    case "f":
      return hasArg && arg != null ? String(Number(arg)) : undefined;
    case "i":
      return hasArg && arg != null ? String(Math.floor(Number(arg))) : undefined;
    case "O":
    case "o":
    case "j":
      if (!hasArg || arg === undefined) {
        return undefined;
      }
      if (typeof arg === "string") {
        return `'${arg}'`;
      }
      if (typeof arg === "function") {
        return arg.name || "<anonymous>";
      }
      return String(serialize(arg));
    case "s":
      return hasArg ? String(arg) : undefined;
    default:
      return undefined;
  }
}

function formatMessage(input: unknown, args: unknown[], serialize: Redactor): unknown {
  if (isRecord(input)) {
    if (args.length === 0) {
      return input;
    }
    // quick-format-unescaped reads args[1..length], skipping args[0]; kept as is.
    const parts = [serialize(input)];
    for (let index = 1; index <= args.length; index += 1) {
      parts.push(serialize(args[index]));
    }
    return parts.join(" ");
  }
  if (typeof input !== "string" || args.length === 0) {
    return input;
  }
  let result = "";
  let argIndex = 0;
  let lastPos = -1;
  const length = input.length;
  for (let index = 0; index < length; index += 1) {
    if (input.charCodeAt(index) !== PERCENT || index + 1 >= length) {
      continue;
    }
    lastPos = lastPos > -1 ? lastPos : 0;
    const directive = input[index + 1];
    const replacement =
      directive === "%"
        ? "%"
        : formatDirective(directive, args[argIndex], argIndex < args.length, serialize);
    if (directive === "%") {
      argIndex -= 1;
    }
    if (replacement !== undefined) {
      result += input.slice(lastPos, index) + replacement;
      lastPos = index + 2;
      index += 1;
    }
    argIndex += 1;
  }
  if (lastPos === -1) {
    return input;
  }
  if (lastPos < length) {
    result += input.slice(lastPos);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Logger

interface LoggerCore {
  stream: Destination;
  redaction: Redaction | null;
}

function serializeField(key: string, value: unknown, core: LoggerCore): string | undefined {
  const redactor = core.redaction?.byKey.get(key);
  if (typeof value === "string") {
    return redactor ? redactor(value) : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const primitive = typeof value === "number" && !Number.isFinite(value) ? null : value;
    return redactor ? redactor(primitive) : String(primitive);
  }
  if (value === undefined || typeof value === "function") {
    return undefined;
  }
  return redactor ? redactor(value) : stringify(value);
}

function bindingsString(bindings: Bindings, core: LoggerCore): string {
  let data = "";
  for (const key of Object.keys(bindings)) {
    const value = bindings[key];
    const reserved = key.length >= BINDING_KEY_CHECK_MIN_LENGTH && RESERVED_BINDING_KEYS.has(key);
    if (reserved || value === undefined) {
      continue;
    }
    const serialized = key === "err" ? serializeError(value, new Set()) : value;
    const redactor = core.redaction?.byKey.get(key);
    const text = redactor ? redactor(serialized) : stringify(serialized);
    if (text !== undefined) {
      data += `,"${key}":${text}`;
    }
  }
  return data;
}

function parseLevel(level: string): LevelWithSilent {
  const lower = level.toLowerCase();
  const candidate = lower in LEVEL_VALUES && lower !== "silent" ? lower : level;
  if (!Object.prototype.hasOwnProperty.call(LEVEL_VALUES, candidate)) {
    throw new Error(`default level:${candidate} must be included in custom levels`);
  }
  return candidate as LevelWithSilent;
}

export class PinoLogger {
  private readonly levelValue: number;

  constructor(
    private readonly core: LoggerCore,
    private readonly chindings: string,
    level: LevelWithSilent,
  ) {
    this.levelValue = LEVEL_VALUES[level];
  }

  isLevelEnabled(level: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(LEVEL_VALUES, level)) {
      return false;
    }
    return LEVEL_VALUES[level as LevelWithSilent] >= this.levelValue;
  }

  child(bindings: Bindings): PinoLogger {
    if (!bindings) {
      throw new Error("missing bindings for child Pino");
    }
    const level = this.levelLabel();
    return new PinoLogger(this.core, this.chindings + bindingsString(bindings, this.core), level);
  }

  trace(objOrMsg: unknown, ...args: unknown[]): void {
    this.log(LEVEL_VALUES.trace, objOrMsg, args);
  }

  debug(objOrMsg: unknown, ...args: unknown[]): void {
    this.log(LEVEL_VALUES.debug, objOrMsg, args);
  }

  info(objOrMsg: unknown, ...args: unknown[]): void {
    this.log(LEVEL_VALUES.info, objOrMsg, args);
  }

  warn(objOrMsg: unknown, ...args: unknown[]): void {
    this.log(LEVEL_VALUES.warn, objOrMsg, args);
  }

  error(objOrMsg: unknown, ...args: unknown[]): void {
    this.log(LEVEL_VALUES.error, objOrMsg, args);
  }

  fatal(objOrMsg: unknown, ...args: unknown[]): void {
    if (!this.log(LEVEL_VALUES.fatal, objOrMsg, args)) {
      return;
    }
    try {
      this.core.stream.flushSync();
    } catch {
      // pino ignores a failed flush after a fatal entry.
    }
  }

  private levelLabel(): LevelWithSilent {
    for (const label of Object.keys(LEVEL_VALUES) as LevelWithSilent[]) {
      if (LEVEL_VALUES[label] === this.levelValue) {
        return label;
      }
    }
    return "silent";
  }

  // Returns whether the level is enabled.
  private log(level: number, objOrMsg: unknown, args: unknown[]): boolean {
    if (level < this.levelValue) {
      return false;
    }
    const serialize = this.core.redaction?.all ?? stringify;
    if (typeof objOrMsg === "object") {
      if (objOrMsg === null && args.length === 0) {
        this.write(null, formatMessage(null, [null], serialize), level);
      } else {
        this.write(objOrMsg, formatMessage(args[0], args.slice(1), serialize), level);
      }
      return true;
    }
    const message = objOrMsg === undefined ? args[0] : objOrMsg;
    const rest = objOrMsg === undefined ? args.slice(1) : args;
    this.write(null, formatMessage(message, rest, serialize), level);
    return true;
  }

  private write(input: unknown, message: unknown, level: number): void {
    let fields: RecordValue = {};
    let msg = message;
    if (input instanceof Error) {
      fields = { err: input };
      if (msg === undefined) {
        msg = input.message;
      }
    } else if (isRecord(input)) {
      fields = input;
      const err = fields.err;
      if (msg === undefined && fields.msg === undefined && err) {
        msg = isRecord(err) ? err.message : undefined;
      }
    }
    let line = `{"level":${level},"time":${Date.now()}${this.chindings}`;
    for (const key of Object.keys(fields)) {
      const raw = fields[key];
      if (raw === undefined) {
        continue;
      }
      const value = key === "err" ? serializeError(raw, new Set()) : raw;
      const text = serializeField(key, value, this.core);
      if (text !== undefined) {
        line += `,${JSON.stringify(key)}:${text}`;
      }
    }
    if (msg !== undefined && typeof msg !== "function") {
      const text =
        typeof msg === "number" || typeof msg === "boolean"
          ? String(typeof msg === "number" && !Number.isFinite(msg) ? null : msg)
          : stringify(msg);
      line += `,"msg":${text}`;
    }
    this.core.stream.write(`${line}}\n`);
  }
}

function pino(options?: LoggerOptions, stream?: Destination): PinoLogger {
  const core: LoggerCore = {
    stream: stream ?? openDestination(1, null),
    redaction: buildRedaction(options?.redact),
  };
  const level = parseLevel(options?.level ?? "info");
  return new PinoLogger(core, PID_AND_HOSTNAME, level);
}

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace pino {
  export type Logger = PinoLogger;

  export function destination(options: DestinationOptions): Destination {
    return openDestination(options.dest, null);
  }
}

export type { PinoLogger as Logger };
export default pino;
