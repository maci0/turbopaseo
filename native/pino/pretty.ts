// Stand-in for npm pino-pretty 13.1.3 in scriptc builds, for the options Paseo passes
// (src/server/logger.ts). It formats the JSON lines of ./index.ts the way pino-pretty does.
import { type Destination, openDestination } from "./index.js";

export interface PrettyOptions {
  colorize: true;
  singleLine: true;
  // Comma-separated top-level keys to drop.
  ignore: string;
  destination: string | number;
}

type RecordValue = Record<string, unknown>;

const EOL = "\n";
const IDENT = "    ";
const MESSAGE_KEY = "msg";
const LEVEL_KEY = "level";
const TIMESTAMP_KEY = "time";
const ERROR_LIKE_KEYS = new Set(["err", "error"]);
const LOGGER_KEYS = ["pid", "hostname", "name", "level", "time", "timestamp", "caller"];
const LEVEL_LABELS: Record<string, string> = {
  60: "FATAL",
  50: "ERROR",
  40: "WARN",
  30: "INFO",
  20: "DEBUG",
  10: "TRACE",
};
const LEVEL_NAMES: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};
const DEFAULT_LEVEL_LABEL = "USERLVL";
const STACK_LINE = /^\s*"stack"/;
const STACK_ENTRY = /^(\s*"stack":)\s*(".*"),?$/;
const STACK_INDENT_EXTRA = 4;
const MILLISECONDS_WIDTH = 3;

// colorette 2.0.20 with colors forced on.
type Color = (input: string) => string;

function replaceClose(index: number, input: string, close: string, replace: string): string {
  const head = input.substring(0, index) + replace;
  const tail = input.substring(index + close.length);
  const next = tail.indexOf(close);
  return head + (next < 0 ? tail : replaceClose(next, tail, close, replace));
}

function color(openCode: number, closeCode: number): Color {
  const open = `\x1b[${openCode}m`;
  const close = `\x1b[${closeCode}m`;
  return (input: string) => {
    if (input === "") {
      return "";
    }
    const index = input.indexOf(close, open.length + 1);
    return index < 0
      ? open + input + close
      : open + replaceClose(index, input, close, open) + close;
  };
}

const gray = color(90, 39);
const cyan = color(36, 39);
const white = color(37, 39);
const LEVEL_COLORS: Record<string, Color> = {
  60: color(41, 49),
  50: color(31, 39),
  40: color(33, 39),
  30: color(32, 39),
  20: color(34, 39),
  10: gray,
};

function isPlainObject(value: unknown): value is RecordValue {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function joinLinesWithIndentation(input: string, ident: string): string {
  const lines = input.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    lines[index] = ident + lines[index];
  }
  return lines.join(EOL);
}

function prettifyLevel(log: RecordValue): string | undefined {
  if (!hasOwn(log, LEVEL_KEY)) {
    return undefined;
  }
  const level = log[LEVEL_KEY];
  let levelNum = "default";
  if (Number.isInteger(Number(level))) {
    const key = String(level);
    levelNum = hasOwn(LEVEL_LABELS, key) ? key : levelNum;
  } else {
    const name = String(level).toLowerCase();
    levelNum = hasOwn(LEVEL_NAMES, name) ? String(LEVEL_NAMES[name]) : levelNum;
  }
  const label = levelNum === "default" ? DEFAULT_LEVEL_LABEL : LEVEL_LABELS[levelNum];
  const paint = hasOwn(LEVEL_COLORS, levelNum) ? LEVEL_COLORS[levelNum] : white;
  return paint(label);
}

function prettifyMessage(log: RecordValue): string | undefined {
  if (!(MESSAGE_KEY in log)) {
    return undefined;
  }
  const message = log[MESSAGE_KEY];
  if (typeof message !== "string" && typeof message !== "number" && typeof message !== "boolean") {
    return undefined;
  }
  return cyan(String(message));
}

function prettifyMetadata(log: RecordValue): string | undefined {
  let line = "";
  if (log.name || log.pid || log.hostname) {
    line += "(";
    if (log.name) {
      line += String(log.name);
    }
    if (log.pid) {
      line += log.name ? `/${String(log.pid)}` : String(log.pid);
    }
    if (log.hostname) {
      line += `${line === "(" ? "on" : " on"} ${String(log.hostname)}`;
    }
    line += ")";
  }
  if (log.caller) {
    line += `${line === "" ? "" : " "}<${String(log.caller)}>`;
  }
  return line === "" ? undefined : line;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

// dateformat 4.6.3 with pino-pretty's default "HH:MM:ss.l" in local time.
function prettifyTime(log: RecordValue): string | undefined {
  let time: unknown = null;
  if (TIMESTAMP_KEY in log) {
    time = log[TIMESTAMP_KEY];
  } else if ("timestamp" in log) {
    time = log.timestamp;
  }
  if (time === null) {
    return undefined;
  }
  let date = new Date(time as string | number);
  if (Number.isNaN(date.getTime())) {
    date = new Date(Number(time));
  }
  if (Number.isNaN(date.getTime())) {
    return `[${String(time)}]`;
  }
  const formatted =
    `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}` +
    `.${pad(date.getMilliseconds(), MILLISECONDS_WIDTH)}`;
  return `[${formatted}]`;
}

function prettifyError(keyName: string, lines: string): string {
  let result = "";
  const joined = joinLinesWithIndentation(lines, IDENT);
  const splitLines = `${IDENT}${keyName}: ${joined}${EOL}`.split(EOL);
  for (let index = 0; index < splitLines.length; index += 1) {
    if (index !== 0) {
      result += EOL;
    }
    const line = splitLines[index];
    const matches = STACK_LINE.test(line) ? STACK_ENTRY.exec(line) : null;
    if (matches !== null && matches.length === 3) {
      const indentation = " ".repeat((/^\s*/.exec(line)?.[0].length ?? 0) + STACK_INDENT_EXTRA);
      const stack = JSON.parse(matches[2]) as string;
      result += matches[1] + EOL + indentation + stack.replace(/\n/g, EOL + indentation);
    } else {
      result += line;
    }
  }
  return result;
}

function prettifyObject(log: RecordValue, skipKeys: string[]): string {
  const ignored = new Set([...skipKeys, ...LOGGER_KEYS]);
  const plain: RecordValue = {};
  const errors: Array<[string, unknown]> = [];
  for (const key of Object.keys(log)) {
    if (ignored.has(key)) {
      continue;
    }
    if (ERROR_LIKE_KEYS.has(key)) {
      errors.push([key, log[key]]);
    } else {
      plain[key] = log[key];
    }
  }
  let result = "";
  if (Object.keys(plain).length > 0) {
    result += gray(JSON.stringify(plain));
  }
  result += EOL;
  result = result.replace(/\\\\/gi, "\\");
  for (const [key, value] of errors) {
    const lines = JSON.stringify(value, null, 2);
    if (lines !== undefined) {
      result += prettifyError(key, lines);
    }
  }
  return result;
}

function prettifyErrorLog(stack: string): string {
  return `${IDENT}${joinLinesWithIndentation(stack, IDENT)}${EOL}`;
}

function prettifyLine(input: string, ignoreKeys: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return input + EOL;
  }
  if (!isPlainObject(parsed)) {
    return input + EOL;
  }
  const message = prettifyMessage(parsed);
  const log: RecordValue = {};
  for (const key of Object.keys(parsed)) {
    if (!ignoreKeys.includes(key)) {
      log[key] = parsed[key];
    }
  }
  const level = prettifyLevel(log);
  const metadata = prettifyMetadata(log);
  const time = prettifyTime(log);

  let line = time ?? "";
  if (level) {
    line = line.length > 0 ? `${line} ${level}` : level;
  }
  if (metadata) {
    line = line.length > 0 ? `${line} ${metadata}:` : metadata;
  }
  if (!line.endsWith(":") && line !== "") {
    line += ":";
  }
  if (message !== undefined) {
    line = line.length > 0 ? `${line} ${message}` : message;
  }

  if (log.type === "Error" && typeof log.stack === "string") {
    return line + EOL + prettifyErrorLog(log.stack);
  }
  const skipKeys = [MESSAGE_KEY, LEVEL_KEY, TIMESTAMP_KEY].filter((key) => {
    const value = log[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  });
  const object = prettifyObject(log, skipKeys);
  if (!/^\s$/.test(object)) {
    line += " ";
  }
  return line + object;
}

export default function pretty(options: PrettyOptions): Destination {
  const ignoreKeys = options.ignore.split(",");
  return openDestination(options.destination, (line) => {
    // pino-pretty reads newline-delimited lines; pino ends every entry with "\n".
    let output = "";
    for (const entry of line.split("\n")) {
      if (entry !== "") {
        output += prettifyLine(entry, ignoreKeys);
      }
    }
    return output;
  });
}
