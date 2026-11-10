// Stand-in for @anthropic-ai/claude-agent-sdk 0.3.246 in native (scriptc) builds: `query`
// and `forkSession`, ported from the package's sdk.mjs (ProcessTransport, Query, the query
// factory, and forkSession's store and disk paths). Every type is the real package's,
// re-exported from copies in ./types/ (sync-types.sh): a tsconfig `paths` entry that maps the
// package name to this file also redirects type imports, so importing the package by name
// would resolve here, and scriptc rejects this file when it imports the declarations from the
// mapped package's own directory (README.md). What is not ported is listed in README.md.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, setMaxListeners } from "node:events";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  CanUseTool,
  ForkSessionOptions,
  ForkSessionResult,
  HookCallback,
  HookCallbackMatcher,
  McpServerConfig,
  OnElicitation,
  OnUserDialog,
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
  SpawnedProcess,
  SpawnOptions,
  ThinkingConfig,
} from "./types/sdk.js";

export type * from "./types/sdk.js";

const SDK_VERSION = "0.3.246";
const SDK_ENTRYPOINT = "sdk-ts";
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const ABORT_MAX_LISTENERS = 50;
/** close(): how long a live CLI gets after stdin ends before SIGTERM. */
const CLOSE_GRACE_MS = 2000;
/** close(): how long after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;
/** Local spawn: how long 'exit' waits for stderr to close. */
const STDERR_DRAIN_MS = 200;
const STDERR_TAIL_CHARS = 2048;
const UNMATCHED_CONTROL_RESPONSES_MAX = 1024;
/** cleanup(): how long it waits for the CLI to exit. */
const CLEANUP_EXIT_WAIT_MS = 2000;
/** readline's default crlfDelay: a '\n' this soon after a chunk ending in '\r' is part of CRLF. */
const CRLF_DELAY_MS = 100;
const REQUEST_ID_RADIX = 36;
const REQUEST_ID_START = 2;
const REQUEST_ID_END = 15;
const PROJECT_KEY_MAX = 200;
const TITLE_SCAN_BYTES = 65536;
const FIRST_PROMPT_MAX = 200;
const CUSTOM_TITLE_MAX = 200;
const GIT_TIMEOUT_MS = 5000;
const TRANSCRIPT_FILE_MODE = 0o600;

type JsonObject = { [key: string]: unknown };
type Env = { [envVar: string]: string | undefined };
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;
type CanUseToolOptions = Parameters<CanUseTool>[2];
type RawHookCallback = (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<unknown>;
type ApplyFlagSettings = Parameters<Query["applyFlagSettings"]>[0];
type InitializeResponse = Awaited<ReturnType<Query["initializationResult"]>>;
type InterruptResponse = Awaited<ReturnType<Query["interrupt"]>>;

interface ErrorTags {
  telemetryMessage?: string;
  errorClass?: string;
  code?: string;
  exitCode?: number;
  signal?: string;
}

/** An Error carrying the SDK's telemetry fields. */
class TaggedError extends Error {
  telemetryMessage?: string;
  errorClass?: string;
  code?: string;
  exitCode?: number;
  signal?: string;
  constructor(message: string, tags: ErrorTags) {
    super(message);
    this.telemetryMessage = tags.telemetryMessage;
    this.errorClass = tags.errorClass;
    this.code = tags.code;
    this.exitCode = tags.exitCode;
    this.signal = tags.signal;
  }
}

/** The SDK's AbortError (its `name` stays "Error", as in the SDK). */
class AbortError extends Error {
  telemetryMessage: string;
  errorClass: string;
  constructor(message: string) {
    super(message);
    this.telemetryMessage = message;
    this.errorClass = "aborted";
  }
}

class TaggedReferenceError extends ReferenceError {
  telemetryMessage: string;
  errorClass: string;
  code?: string;
  constructor(message: string, tags: { telemetryMessage: string; errorClass: string; code?: string }) {
    super(message);
    this.telemetryMessage = tags.telemetryMessage;
    this.errorClass = tags.errorClass;
    this.code = tags.code;
  }
}

class TelemetrySafeError extends Error {
  telemetryMessage: string;
  constructor(message: string, telemetryMessage: string) {
    super(message);
    this.name = "TelemetrySafeError";
    this.telemetryMessage = telemetryMessage;
  }
}

/** What Node's spawn() emits as 'error' when its `signal` aborts a live child. */
class SpawnAbortError extends Error {
  code: string;
  constructor() {
    super("The operation was aborted");
    this.name = "AbortError";
    this.code = "ABORT_ERR";
  }
}

function abortedByUser(): AbortError {
  return new AbortError("Claude Code process aborted by user");
}

function operationAborted(): AbortError {
  return new AbortError("Operation aborted");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function errnoCode(value: unknown): string | undefined {
  if (value instanceof Error) {
    const code = (value as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return undefined;
}

const SPAWN_FAILURE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EROFS"]);

function isSpawnFailureCode(value: unknown): boolean {
  const code = errnoCode(value);
  return code !== undefined && SPAWN_FAILURE_CODES.has(code);
}

function codeSuffix(value: unknown): string {
  const code = errnoCode(value);
  return code === undefined ? "" : ` (${code})`;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());
}

function createAbortController(): AbortController {
  const controller = new AbortController();
  setMaxListeners(ABORT_MAX_LISTENERS, controller.signal);
  return controller;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

/** The last `max` characters of `text`, without a split surrogate pair at the start. */
function tail(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const sliced = text.slice(-max);
  const first = sliced.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? sliced.slice(1) : sliced;
}

/** The first `max` characters of `text`, without a split surrogate pair at the end. */
function head(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const last = sliced.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// CLI arguments

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SKILL_NAME_FORBIDDEN = /[(),\u0000-\u001f\u007f-\u009f]/;

function validateSkillName(name: string): string {
  if (name.trim() === "") throw new Error("Skill names must be non-empty strings.");
  const quoted = JSON.stringify(name);
  if (LONE_SURROGATE.test(name))
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: the name contains an unpaired surrogate, which cannot survive the UTF-8 encoding of the CLI invocation; no skill discovered from the filesystem can have such a name.`,
      "skill name with unpaired surrogate rejected"
    );
  if (name !== name.trim())
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: leading or trailing whitespace is not allowed \u2014 the Skill tool trims the invoked name, so a padded rule can never match. Remove the padding.`,
      "skill name with surrounding whitespace rejected"
    );
  if (SKILL_NAME_FORBIDDEN.test(name))
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: parentheses, commas, and control characters are not allowed in skill names. Skill names match the skill's directory name (or 'plugin:skill' for plugin-qualified skills); rename the skill if its directory name contains these characters.`,
      "invalid skill name rejected"
    );
  if (name === "*") throw new Error("Invalid skill name '*': use skills: 'all' to enable every skill.");
  if (name.endsWith(":*") || name.endsWith(" *"))
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: wildcard-suffix names are not allowed; list each skill by its exact name.`,
      "wildcard-suffix skill name rejected"
    );
  if (name.startsWith("/"))
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: skill names may not start with '/'. Skills are invoked as slash commands, but the skills option takes the skill's canonical name \u2014 the directory name, or 'plugin:skill'.`,
      "skill name with leading slash rejected"
    );
  if (name.includes("\\\\"))
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: consecutive backslashes are not allowed \u2014 the permission-rule parser collapses escaped backslashes, so the rule would name a different skill. Rename the skill.`,
      "skill name with consecutive backslashes rejected"
    );
  if (name.endsWith("\\"))
    throw new TelemetrySafeError(
      `Invalid skill name ${quoted}: names may not end with an unpaired backslash.`,
      "skill name with unpaired trailing backslash rejected"
    );
  return name;
}

/** `--flag value`, or `--flag=value` when the value looks like a flag. */
function pushFlag(args: string[], flag: string, value: string): void {
  if (value.length > 1 && value.startsWith("-")) args.push(`--${flag}=${value}`);
  else args.push(`--${flag}`, value);
}

function looksLikeJsonObject(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

/** Folds Options.sandbox into the `settings` extra argument. */
function mergeSandboxSettings(
  extraArgs: Record<string, string | null>,
  sandbox: Options["sandbox"]
): Record<string, string | null> {
  const merged: Record<string, string | null> = { ...extraArgs };
  if (!sandbox) return merged;
  // An untyped record keeps insertion order natively, so failIfUnavailable lands last as in Node.
  const fields = sandbox as unknown as JsonObject;
  const effective: JsonObject =
    sandbox.enabled === true && sandbox.failIfUnavailable === undefined
      ? { ...fields, failIfUnavailable: true }
      : fields;
  const settings = merged["settings"];
  if (settings && !looksLikeJsonObject(settings))
    throw new Error(
      "Cannot use both a settings file path and the sandbox option. Include the sandbox configuration in your settings file instead."
    );
  let combined: JsonObject = { sandbox: effective };
  if (settings) {
    try {
      const parsed: unknown = JSON.parse(settings);
      combined = { ...(parsed as JsonObject), sandbox: effective };
    } catch {
      /* the SDK keeps { sandbox } alone when the settings string is not JSON */
    }
  }
  merged["settings"] = JSON.stringify(combined);
  return merged;
}

function isScriptPath(executablePath: string): boolean {
  return [".js", ".mjs", ".tsx", ".ts", ".jsx"].some((ext) => executablePath.endsWith(ext));
}

interface TransportOptions {
  abortController: AbortController;
  additionalDirectories: string[];
  agent?: string;
  betas?: string[];
  cwd?: string;
  debug?: boolean;
  debugFile?: string;
  executable: string;
  executableArgs: string[];
  extraArgs: Record<string, string | null>;
  pathToClaudeCodeExecutable: string;
  env: Env;
  forkSession?: boolean;
  stderr?: (data: string) => void;
  thinkingConfig?: ThinkingConfig;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  taskBudget?: { total: number };
  model?: string;
  fallbackModel?: string;
  jsonSchema?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
  permissionPromptToolName?: string;
  continueConversation?: boolean;
  resume?: string;
  resumeSessionAt?: string;
  resumeDropsTurn?: string;
  sessionId?: string;
  settings?: string;
  managedSettings?: string;
  settingSources?: string[];
  skills?: string[] | "all";
  allowedTools: string[];
  disallowedTools: string[];
  tools?: Options["tools"];
  mcpServers: Record<string, McpServerConfig>;
  strictMcpConfig?: boolean;
  canUseTool: boolean;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  persistSession?: boolean;
  plugins?: Options["plugins"];
  sandbox?: Options["sandbox"];
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
}

/** The CLI flags for `options` (ProcessTransport.initialize in sdk.mjs). */
function buildArgs(options: TransportOptions): string[] {
  let allowedTools = options.allowedTools;
  const skills = options.skills;
  if (skills !== undefined) {
    const rules = skills === "all" ? ["Skill"] : skills.map((name) => `Skill(${validateSkillName(name)})`);
    const present = new Set(allowedTools);
    allowedTools = [...allowedTools, ...rules.filter((rule) => !present.has(rule))];
  }
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
  const thinking = options.thinkingConfig;
  if (thinking) {
    if (thinking.type === "enabled") {
      if (thinking.budgetTokens === undefined) args.push("--thinking", "adaptive");
      else args.push("--max-thinking-tokens", thinking.budgetTokens.toString());
      if (thinking.display) args.push("--thinking-display", thinking.display);
    } else if (thinking.type === "disabled") {
      args.push("--thinking", "disabled");
    } else {
      args.push("--thinking", "adaptive");
      if (thinking.display) args.push("--thinking-display", thinking.display);
    }
  }
  if (options.effort) args.push("--effort", options.effort);
  if (options.maxTurns) args.push("--max-turns", options.maxTurns.toString());
  if (options.maxBudgetUsd !== undefined) args.push("--max-budget-usd", options.maxBudgetUsd.toString());
  if (options.taskBudget) args.push("--task-budget", options.taskBudget.total.toString());
  if (options.model) args.push("--model", options.model);
  if (options.agent) args.push("--agent", options.agent);
  if (options.betas && options.betas.length > 0) args.push("--betas", options.betas.join(","));
  if (options.jsonSchema) args.push("--json-schema", JSON.stringify(options.jsonSchema));
  if (options.debugFile) args.push("--debug-file", options.debugFile);
  else if (options.debug) args.push("--debug");
  if (options.canUseTool) {
    if (options.permissionPromptToolName)
      throw new Error("canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.");
    args.push("--permission-prompt-tool", "stdio");
  } else if (options.permissionPromptToolName) {
    args.push("--permission-prompt-tool", options.permissionPromptToolName);
  }
  if (options.continueConversation) args.push("--continue");
  if (options.resume) args.push(`--resume=${options.resume}`);
  if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
  if (options.disallowedTools.length > 0) args.push("--disallowedTools", options.disallowedTools.join(","));
  const tools = options.tools;
  if (tools !== undefined) {
    if (Array.isArray(tools)) args.push("--tools", tools.length === 0 ? "" : tools.join(","));
    else args.push("--tools", "default");
  }
  if (Object.keys(options.mcpServers).length > 0)
    args.push("--mcp-config", JSON.stringify({ mcpServers: options.mcpServers }));
  if (options.settingSources !== undefined) args.push(`--setting-sources=${options.settingSources.join(",")}`);
  if (options.strictMcpConfig) args.push("--strict-mcp-config");
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.allowDangerouslySkipPermissions) args.push("--allow-dangerously-skip-permissions");
  if (options.fallbackModel) {
    if (options.model && options.fallbackModel === options.model)
      throw new Error(
        "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option."
      );
    args.push("--fallback-model", options.fallbackModel);
  }
  if (options.includeHookEvents) args.push("--include-hook-events");
  if (options.includePartialMessages) args.push("--include-partial-messages");
  for (const dir of options.additionalDirectories) args.push("--add-dir", dir);
  for (const plugin of options.plugins ?? []) {
    if (plugin.type === "local")
      args.push(plugin.skipMcpDiscovery ? "--plugin-dir-no-mcp" : "--plugin-dir", plugin.path);
    else throw new Error(`Unsupported plugin type: ${String(plugin.type)}`);
  }
  if (options.forkSession) args.push("--fork-session");
  if (options.resumeSessionAt) args.push(`--resume-session-at=${options.resumeSessionAt}`);
  if (options.resumeDropsTurn !== undefined) args.push(`--resume-drops-turn=${options.resumeDropsTurn}`);
  if (options.sessionId) args.push(`--session-id=${options.sessionId}`);
  if (options.persistSession === false) args.push("--no-session-persistence");
  if (options.managedSettings) args.push("--managed-settings", options.managedSettings);
  const extraArgs: Record<string, string | null> = { ...options.extraArgs };
  if (options.settings) extraArgs["settings"] = options.settings;
  for (const [flag, value] of Object.entries(mergeSandboxSettings(extraArgs, options.sandbox))) {
    if (value === null) args.push(`--${flag}`);
    else pushFlag(args, flag, value);
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// Process transport

/** Kills every live CLI with SIGTERM when this process exits, as the SDK's tracker does. */
class ProcessTracker {
  private readonly processes = new Set<SpawnedProcess>();
  private listening = false;

  track(child: SpawnedProcess): void {
    this.processes.add(child);
    if (this.listening) return;
    this.listening = true;
    process.on("exit", () => this.killAll());
  }

  untrack(child: SpawnedProcess): void {
    this.processes.delete(child);
  }

  private killAll(): void {
    for (const child of this.processes) {
      if (child.killed) continue;
      if (process.platform === "win32") {
        try {
          child.stdin.end();
        } catch {
          /* the CLI may already be gone; nothing to report at process exit */
        }
      } else child.kill("SIGTERM");
    }
  }
}

const processTracker = new ProcessTracker();

/**
 * The CLI spawned by the SDK itself. 'exit' is delivered once stderr has closed (or
 * STDERR_DRAIN_MS after the process exit), so the stderr tail is complete in exit errors.
 * Node's spawn() `signal` option is emulated: on abort a live child gets SIGTERM and 'error'.
 */
class LocalProcess implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();

  constructor(
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal,
    onStderr: (text: string) => void,
    onExit: () => void,
    onStderrEnd: (text: string) => void
  ) {
    this.child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    const decoder = new StringDecoder("utf8");
    let stderrClosed = false;
    let exited = false;
    let drained = false;
    let drainTimer: NodeJS.Timeout | undefined;
    child.on("error", (error: Error) => {
      this.events.emit("error", error);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (drained) return;
      onStderr(decoder.write(chunk));
    });
    child.stderr.on("error", () => {
      /* the SDK only logs stderr read failures to its debug log */
    });
    const deliverExit = (): void => {
      if (drained) return;
      drained = true;
      if (drainTimer) clearTimeout(drainTimer);
      this.events.emit("exit", child.exitCode, child.signalCode);
      unrefOrDestroy(child.stderr);
    };
    child.stderr.once("close", () => {
      onStderrEnd(decoder.end());
      stderrClosed = true;
      if (exited) deliverExit();
    });
    child.once("exit", () => {
      exited = true;
      onExit();
      if (stderrClosed) deliverExit();
      else drainTimer = setTimeout(deliverExit, STDERR_DRAIN_MS);
    });
    const onAbort = (): void => {
      try {
        if (child.kill("SIGTERM")) this.events.emit("error", new SpawnAbortError());
      } catch (error) {
        this.events.emit("error", toError(error));
      }
    };
    if (signal.aborted) process.nextTick(onAbort);
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbort));
    }
  }

  get killed(): boolean {
    return this.child.killed;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.events.on(event, listener);
  }

  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.events.once(event, listener);
  }

  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
  off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.events.off(event, listener);
  }
}

function unrefOrDestroy(stream: Readable): void {
  const handle = stream as Readable & { unref?: () => void };
  if (typeof handle.unref === "function") handle.unref();
  else stream.destroy();
}

/**
 * readline's line splitting over a byte stream: lines end at "\n", "\r\n" or "\r"; a final
 * unterminated line is emitted at end of input. close() stops reading; lines already split
 * are still yielded.
 */
class LineReader implements AsyncIterable<string> {
  private readonly input: Readable;
  private readonly decoder = new StringDecoder("utf8");
  private readonly lines: string[] = [];
  private buffer = "";
  private sawReturnAt = 0;
  private closed = false;
  private failure: Error | undefined;
  private waiter: ((result: IteratorResult<string, undefined>) => void) | undefined;
  private failWaiter: ((error: Error) => void) | undefined;
  private readonly onData = (chunk: Buffer | string): void => this.write(chunk);
  private readonly onEnd = (): void => this.end();
  private readonly onError = (error: Error): void => this.fail(error);

  constructor(input: Readable) {
    this.input = input;
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("error", this.onError);
    input.resume();
  }

  private write(chunk: Buffer | string): void {
    let text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.sawReturnAt && Date.now() - this.sawReturnAt <= CRLF_DELAY_MS) {
      if (text.startsWith("\n")) text = text.slice(1);
      this.sawReturnAt = 0;
    }
    const lineEnding = /\r?\n|\r(?!\n)/g;
    if (!lineEnding.test(text)) {
      if (text) this.buffer += text;
      return;
    }
    text = this.buffer + text;
    this.buffer = "";
    this.sawReturnAt = text.endsWith("\r") ? Date.now() : 0;
    lineEnding.lastIndex = 0;
    let start = 0;
    let match = lineEnding.exec(text);
    while (match !== null) {
      this.push(text.slice(start, match.index));
      start = lineEnding.lastIndex;
      match = lineEnding.exec(text);
    }
    this.buffer = text.slice(start);
  }

  private end(): void {
    const rest = this.buffer + this.decoder.end();
    this.buffer = "";
    if (rest.length > 0) this.push(rest);
    this.close();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.close();
  }

  private push(line: string): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      this.failWaiter = undefined;
      waiter({ done: false, value: line });
    } else this.lines.push(line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onError);
    this.input.pause();
    const waiter = this.waiter;
    const failWaiter = this.failWaiter;
    this.waiter = undefined;
    this.failWaiter = undefined;
    if (this.failure && failWaiter) failWaiter(this.failure);
    else if (waiter) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<string, undefined>> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve({ done: false, value: line });
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.failWaiter = reject;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<string, undefined> {
    return { next: () => this.next(), return: () => this.stop() };
  }

  private stop(): Promise<IteratorResult<string, undefined>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }
}

interface ExitListenerEntry {
  callback: (error: Error | undefined) => void;
  handler: ExitListener;
}

class ProcessTransport {
  private readonly options: TransportOptions;
  private process: SpawnedProcess | undefined;
  private processStdin: Writable | undefined;
  private processStdout: Readable | undefined;
  private ready = false;
  private readonly abortController: AbortController;
  private exitError: Error | undefined;
  private exitEventDelivered = false;
  private stderrTail = "";
  private exitListeners: ExitListenerEntry[] = [];
  private abortHandler: (() => void) | undefined;
  private readonly forwardedAbort = createAbortController();

  constructor(options: TransportOptions) {
    this.options = options;
    this.abortController = options.abortController;
    this.initialize();
  }

  private appendStderr(text: string): void {
    this.stderrTail += text;
    if (this.stderrTail.length > 2 * STDERR_TAIL_CHARS) this.stderrTail = tail(this.stderrTail, STDERR_TAIL_CHARS);
  }

  private spawnLocalProcess(spawnOptions: SpawnOptions): SpawnedProcess {
    // Two calls because scriptc cannot hold `cwd: undefined` in spawn()'s options.
    const cwd = spawnOptions.cwd;
    const child =
      cwd === undefined
        ? spawn(spawnOptions.command, spawnOptions.args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: spawnOptions.env,
            windowsHide: true,
          })
        : spawn(spawnOptions.command, spawnOptions.args, {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: spawnOptions.env,
            windowsHide: true,
          });
    const forward = isTruthyEnv(spawnOptions.env["DEBUG_CLAUDE_AGENT_SDK"]) || this.options.stderr !== undefined;
    return new LocalProcess(
      child,
      spawnOptions.signal,
      (text) => {
        this.appendStderr(text);
        if (forward) this.options.stderr?.(text);
      },
      () => {
        this.ready = false;
      },
      (text) => {
        this.stderrTail += text;
      }
    );
  }

  private initialize(): void {
    try {
      const options = this.options;
      const args = buildArgs(options);
      const env = options.env;
      if (!env["CLAUDE_CODE_ENTRYPOINT"]) env["CLAUDE_CODE_ENTRYPOINT"] = SDK_ENTRYPOINT;
      delete env["NODE_OPTIONS"];
      if (isTruthyEnv(env["DEBUG_CLAUDE_AGENT_SDK"])) env["DEBUG"] = "1";
      else delete env["DEBUG"];
      const executablePath = options.pathToClaudeCodeExecutable;
      const nativeBinary = !isScriptPath(executablePath);
      const command = nativeBinary ? executablePath : options.executable;
      const commandArgs = nativeBinary
        ? [...options.executableArgs, ...args]
        : [...options.executableArgs, executablePath, ...args];
      const spawnOptions: SpawnOptions = {
        command,
        args: commandArgs,
        cwd: options.cwd,
        env,
        signal: this.forwardedAbort.signal,
      };
      const child = options.spawnClaudeCodeProcess
        ? options.spawnClaudeCodeProcess(spawnOptions)
        : this.spawnLocalProcess(spawnOptions);
      this.process = child;
      this.processStdin = child.stdin;
      this.processStdout = child.stdout;
      child.stdin.on("error", () => {
        this.ready = false;
      });
      processTracker.track(child);
      const abortHandler = (): void => this.close();
      this.abortHandler = abortHandler;
      this.abortController.signal.addEventListener("abort", abortHandler);
      if (this.abortController.signal.aborted) this.close();
      child.on("error", (error: Error) => {
        this.ready = false;
        const syscall = (error as NodeJS.ErrnoException).syscall;
        const spawnFailed = syscall !== undefined ? syscall.startsWith("spawn") : isSpawnFailureCode(error);
        if (spawnFailed && !child.killed) processTracker.untrack(child);
        if (this.abortController.signal.aborted) {
          this.exitError = abortedByUser();
        } else if (spawnFailed && isSpawnFailureCode(error)) {
          const failure = describeLaunchFailure(executablePath, nativeBinary);
          this.exitError = new TaggedReferenceError(failure.message, {
            telemetryMessage: `${failure.telemetryMessage}${codeSuffix(error)}`,
            errorClass: failure.errorClass,
            code: errnoCode(error),
          });
        } else {
          this.exitError = new TaggedError(`Failed to spawn Claude Code process: ${error.message}`, {
            telemetryMessage: spawnFailed
              ? `Failed to spawn Claude Code process${codeSuffix(error)}`
              : `Claude Code process error${codeSuffix(error)}`,
            errorClass: spawnFailed ? "spawn_failed" : "process_error",
            code: errnoCode(error),
          });
        }
      });
      child.on("exit", (code, signal) => {
        this.exitEventDelivered = true;
        this.ready = false;
        if (this.abortController.signal.aborted) this.exitError = abortedByUser();
        else {
          const exitError = this.getProcessExitError(code, signal);
          if (exitError) this.exitError = exitError;
        }
      });
      this.ready = !this.abortController.signal.aborted;
    } catch (error) {
      this.ready = false;
      throw error;
    }
  }

  private getProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error | undefined {
    if (code !== 0 && code !== null) {
      const exitCode = Number.isInteger(code) ? code : undefined;
      return new TaggedError(`Claude Code process exited with code ${code}${this.formatStderrTail()}`, {
        telemetryMessage: `Claude Code process exited with code ${exitCode ?? "unknown"}`,
        errorClass: "process_exited_nonzero",
        exitCode,
      });
    }
    if (signal) {
      const name = /^SIG[A-Z0-9]{1,8}$/.test(signal) ? signal : "unknown";
      return new TaggedError(`Claude Code process terminated by signal ${signal}${this.formatStderrTail()}`, {
        telemetryMessage: `Claude Code process terminated by signal ${name}`,
        errorClass: "process_killed_by_signal",
        signal: name,
      });
    }
    return undefined;
  }

  private formatStderrTail(): string {
    const text = tail(this.stderrTail, STDERR_TAIL_CHARS).trim();
    return text ? `. stderr: ${text}` : "";
  }

  write(data: string): void {
    if (this.abortController.signal.aborted) throw operationAborted();
    if (!this.ready || !this.processStdin) throw new Error("ProcessTransport is not ready for writing");
    if (this.processStdin.writableEnded) return;
    if (this.process?.killed || this.process?.exitCode !== null) throw new Error("Cannot write to terminated process");
    if (this.exitError) throw new Error(`Cannot write to process that exited with error: ${this.exitError.message}`);
    try {
      this.processStdin.write(data);
    } catch (error) {
      this.ready = false;
      throw new Error(`Failed to write to process stdin: ${errorMessage(error)}`);
    }
  }

  close(): void {
    if (this.processStdin) {
      this.processStdin.end();
      this.processStdin = undefined;
    }
    if (this.abortHandler) {
      this.abortController.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = undefined;
    }
    const child = this.process;
    const exitCode = child?.exitCode ?? null;
    const signalCode = child?.signalCode ?? null;
    const exitedUnseen = !this.exitEventDelivered && ((exitCode !== null && exitCode >= 0) || signalCode !== null);
    let exitError: Error | undefined;
    if (exitedUnseen) {
      this.exitEventDelivered = true;
      exitError = this.abortController.signal.aborted
        ? abortedByUser()
        : this.getProcessExitError(exitCode, signalCode);
      if (exitError && !this.exitError) this.exitError = exitError;
    }
    const listeners = this.exitListeners;
    this.exitListeners = [];
    for (const { callback, handler } of listeners) {
      child?.off("exit", handler);
      if (exitedUnseen) {
        try {
          callback(exitError);
        } catch {
          /* the SDK only logs a throwing onExit callback */
        }
      }
    }
    const forwardAbort = (): void => {
      if (this.abortController.signal.aborted) this.forwardedAbort.abort(this.abortController.signal.reason);
    };
    if (child && !child.killed && child.exitCode === null && child.signalCode == null) {
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode != null) {
          forwardAbort();
          return;
        }
        if (process.platform === "win32") {
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            forwardAbort();
          }, KILL_GRACE_MS).unref();
          return;
        }
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref();
        forwardAbort();
      }, CLOSE_GRACE_MS).unref();
      child.once("exit", () => processTracker.untrack(child));
    } else if (child) {
      processTracker.untrack(child);
      forwardAbort();
    }
    this.ready = false;
  }

  async *readMessages(): AsyncGenerator<unknown, void, undefined> {
    const stdout = this.processStdout;
    if (!stdout) throw new Error("ProcessTransport output stream not available");
    if (this.exitError) throw this.exitError;
    const lines = new LineReader(stdout);
    const child = this.process;
    const closeOnError = (): void => lines.close();
    child?.on("error", closeOnError);
    if (this.exitError) lines.close();
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        yield message;
      }
      if (this.exitError) throw this.exitError;
      await this.waitForExit();
    } finally {
      child?.off("error", closeOnError);
      lines.close();
    }
  }

  endInput(): void {
    if (this.processStdin) this.processStdin.end();
  }

  waitForExit(): Promise<void> {
    if (this.exitError) return Promise.reject(this.exitError);
    const child = this.process;
    if (!child || child.exitCode === 0 || (child.killed && this.exitEventDelivered)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.abortController.signal.aborted) {
          reject(operationAborted());
          return;
        }
        const exitError = this.getProcessExitError(code, signal);
        if (exitError) reject(exitError);
        else resolve();
      };
      child.once("exit", onExit);
      const onError = (error: Error): void => {
        child.off("exit", onExit);
        reject(error);
      };
      child.once("error", onError);
      child.once("exit", () => child.off("error", onError));
    });
  }
}

function describeLaunchFailure(
  executablePath: string,
  nativeBinary: boolean
): { message: string; telemetryMessage: string; errorClass: string } {
  const kind = nativeBinary ? "native binary" : "executable";
  let exists = false;
  try {
    realpathSync(executablePath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists)
    return {
      message: nativeBinary
        ? `Claude Code native binary at ${executablePath} exists but failed to launch. This usually means the binary does not match this system's libc \u2014 e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.`
        : `Claude Code executable at ${executablePath} exists but failed to launch.`,
      telemetryMessage: `Claude Code ${kind} exists at the configured path but failed to launch`,
      errorClass: "executable_launch_failed",
    };
  return {
    message: nativeBinary
      ? `Claude Code native binary not found at ${executablePath}. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.`
      : `Claude Code executable not found at ${executablePath}. Is options.pathToClaudeCodeExecutable set?`,
    telemetryMessage: `Claude Code ${kind} not found at the configured path`,
    errorClass: "executable_not_found",
  };
}

// ---------------------------------------------------------------------------------------------
// Query

/** The message queue between the reader and the consumer (the SDK's stream class). */
class MessageStream implements AsyncIterable<SDKMessage> {
  private readonly queue: SDKMessage[] = [];
  private readResolve: ((result: IteratorResult<SDKMessage, undefined>) => void) | undefined;
  private readReject: ((error: Error) => void) | undefined;
  private isDone = false;
  private failure: Error | undefined;
  private started = false;

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, undefined> {
    if (this.started) throw new Error("Stream can only be iterated once");
    this.started = true;
    return { next: () => this.next(), return: () => this.stop() };
  }

  next(): Promise<IteratorResult<SDKMessage, undefined>> {
    const item = this.queue.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.isDone) return Promise.resolve({ done: true, value: undefined });
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

  enqueue(message: SDKMessage): void {
    const resolve = this.readResolve;
    if (resolve) {
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: false, value: message });
    } else this.queue.push(message);
  }

  done(): void {
    this.isDone = true;
    const resolve = this.readResolve;
    if (resolve) {
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  error(error: Error): void {
    this.failure = error;
    const reject = this.readReject;
    if (reject) {
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(error);
    }
  }

  private stop(): Promise<IteratorResult<SDKMessage, undefined>> {
    this.isDone = true;
    return Promise.resolve({ done: true, value: undefined });
  }
}

interface ControlResponse {
  subtype: string;
  request_id: string;
  response?: JsonObject;
  error?: string;
  pending_permission_requests?: ControlRequestEnvelope[];
  pending_user_dialog_requests?: ControlRequestEnvelope[];
}

interface ControlRequestEnvelope {
  type: string;
  request_id: string;
  request: JsonObject;
}

interface PendingControlResponse {
  handler: (response: ControlResponse) => void;
  reject: (error: Error) => void;
}

interface InitConfig {
  systemPrompt?: string | string[];
  appendSystemPrompt?: string;
  planModeInstructions?: string;
  toolAliases?: Record<string, string>;
  excludeDynamicSections?: boolean;
  agents?: Options["agents"];
  title?: string;
  skills?: string[] | "all";
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
  forwardSubagentText?: boolean;
  supportedDialogKinds?: string[];
  perTaskStopAffordance?: boolean;
}

interface QueryCallbacks {
  canUseTool?: CanUseTool;
  hooks?: Options["hooks"];
  onElicitation?: OnElicitation;
  onUserDialog?: OnUserDialog;
}

type ControlReply = { suppress: true } | { suppress: false; response: unknown };

function stringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

class NativeQuery implements Query {
  private readonly transport: ProcessTransport;
  private isSingleUserTurn: boolean;
  private readonly callbacks: QueryCallbacks;
  private readonly abortController: AbortController;
  private readonly jsonSchema: Record<string, unknown> | undefined;
  private readonly initConfig: InitConfig;
  private readonly pendingControlResponses = new Map<string, PendingControlResponse>();
  private readonly unmatchedControlResponses = new Map<string, ControlResponse>();
  private cleanupPerformed = false;
  private readonly sdkMessages: AsyncGenerator<SDKMessage, void, unknown>;
  private readonly inputStream = new MessageStream();
  private readonly initialization: Promise<InitializeResponse>;
  private readonly cancelControllers = new Map<string, AbortController>();
  private readonly hookCallbacks = new Map<string, HookCallback>();
  private nextCallbackId = 0;
  private initHooksPayload: JsonObject | undefined;
  private firstResultReceivedResolve: (() => void) | undefined;
  private firstResultReceived = false;
  private lastErrorResultText: string | undefined;
  private latestCommands: unknown[] | undefined;
  private cleanupCallbacks: Array<() => void> = [];
  private cleanupPromise: Promise<void> | undefined;

  constructor(
    transport: ProcessTransport,
    isSingleUserTurn: boolean,
    callbacks: QueryCallbacks,
    abortController: AbortController,
    jsonSchema: Record<string, unknown> | undefined,
    initConfig: InitConfig
  ) {
    this.transport = transport;
    this.isSingleUserTurn = isSingleUserTurn;
    this.callbacks = callbacks;
    this.abortController = abortController;
    this.jsonSchema = jsonSchema;
    this.initConfig = initConfig;
    this.sdkMessages = this.readSdkMessages();
    void this.readMessages();
    this.initialization = this.initialize();
    this.initialization.catch(() => {
      /* surfaced through initializationResult() and the methods that await it */
    });
  }

  private hasBidirectionalNeeds(): boolean {
    const { hooks, canUseTool, onElicitation, onUserDialog } = this.callbacks;
    return (
      (hooks !== undefined && Object.keys(hooks).length > 0) ||
      canUseTool !== undefined ||
      onElicitation !== undefined ||
      onUserDialog !== undefined
    );
  }

  private addCleanupCallback(callback: () => void): void {
    if (this.cleanupPerformed) callback();
    else this.cleanupCallbacks.push(callback);
  }

  close(): void {
    void this.cleanup();
  }

  private cleanup(error?: Error): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPerformed = true;
    this.cleanupPromise = this.performCleanup(error);
    return this.cleanupPromise;
  }

  private async performCleanup(error: Error | undefined): Promise<void> {
    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch {
        /* the SDK ignores a throwing cleanup callback */
      }
    }
    this.cleanupCallbacks = [];
    try {
      for (const controller of this.cancelControllers.values()) controller.abort();
      this.cancelControllers.clear();
      this.transport.close();
      const reason = error ?? new Error("Query closed before response received");
      for (const { reject } of this.pendingControlResponses.values()) reject(reason);
      this.pendingControlResponses.clear();
      this.unmatchedControlResponses.clear();
      this.hookCallbacks.clear();
      if (error) this.inputStream.error(error);
      else this.inputStream.done();
    } catch {
      /* the SDK swallows failures while tearing down */
    }
    const timer = new AbortController();
    try {
      await Promise.race([this.transport.waitForExit(), delay(CLEANUP_EXIT_WAIT_MS, timer.signal)]);
    } catch {
      /* an exit error already reached the stream */
    } finally {
      timer.abort();
    }
  }

  next(value?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return this.sdkMessages.next(value);
  }

  /** The SDK forwards its argument, which a `void` generator can only receive as undefined. */
  async return(): Promise<IteratorResult<SDKMessage, void>> {
    await this.cleanup();
    return this.sdkMessages.return();
  }

  async throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
    await this.cleanup();
    return this.sdkMessages.throw(error);
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void, unknown> {
    return this.sdkMessages;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }

  private async readMessages(): Promise<void> {
    try {
      for await (const value of this.transport.readMessages()) {
        if (value === null) throw new TypeError("Cannot read properties of null (reading 'type')");
        if (!isObject(value)) {
          this.lastErrorResultText = undefined;
          this.inputStream.enqueue(value as SDKMessage);
          continue;
        }
        const message = value;
        const type = message["type"];
        if (type === "control_response") {
          const response = message["response"] as ControlResponse;
          const pending = this.pendingControlResponses.get(response.request_id);
          if (pending) pending.handler(response);
          else {
            if (this.unmatchedControlResponses.size >= UNMATCHED_CONTROL_RESPONSES_MAX) {
              const oldest = this.unmatchedControlResponses.keys().next().value;
              if (oldest !== undefined) this.unmatchedControlResponses.delete(oldest);
            }
            this.unmatchedControlResponses.set(response.request_id, response);
          }
          continue;
        }
        if (type === "control_request") {
          void this.handleControlRequest(message as unknown as ControlRequestEnvelope);
          continue;
        }
        if (type === "control_cancel_request") {
          this.handleControlCancelRequest(String(message["request_id"]));
          continue;
        }
        if (type === "keep_alive") continue;
        if (type === "transcript_mirror") continue;
        const subtype = message["subtype"];
        if (type === "system" && subtype === "commands_changed" && Array.isArray(message["commands"]))
          this.latestCommands = message["commands"];
        if (type === "system" && (subtype === "post_turn_summary" || subtype === "task_summary")) {
          this.inputStream.enqueue(message as unknown as SDKMessage);
          continue;
        }
        if (type === "active_goal" || type === "autocompact_state") {
          this.inputStream.enqueue(message as unknown as SDKMessage);
          continue;
        }
        if (type === "result") {
          let errorText: string | undefined;
          if (message["is_error"]) {
            if (subtype === "success") errorText = message["result"] as string | undefined;
            else
              errorText = (message["errors"] as string[])
                .map((entry) => entry.trim())
                .filter(Boolean)
                .join("; ");
          }
          this.lastErrorResultText = errorText || undefined;
          this.firstResultReceived = true;
          this.firstResultReceivedResolve?.();
          if (this.isSingleUserTurn) this.transport.endInput();
        } else if (!(type === "system" && subtype === "session_state_changed")) {
          this.lastErrorResultText = undefined;
        }
        this.inputStream.enqueue(message as unknown as SDKMessage);
      }
      this.firstResultReceivedResolve?.();
      this.inputStream.done();
      void this.cleanup();
    } catch (caught) {
      this.firstResultReceivedResolve?.();
      const error = toError(caught);
      if (this.lastErrorResultText !== undefined && !(caught instanceof AbortError) && error.name !== "SSEHttpError") {
        const replaced = new TaggedError(`Claude Code returned an error result: ${this.lastErrorResultText}`, {
          telemetryMessage: "Claude Code returned an error result",
          errorClass: "error_result",
        });
        this.inputStream.error(replaced);
        void this.cleanup(replaced);
        return;
      }
      this.inputStream.error(error);
      void this.cleanup(error);
    }
  }

  private async handleControlRequest(envelope: ControlRequestEnvelope): Promise<void> {
    if (this.cancelControllers.has(envelope.request_id)) return;
    const controller = new AbortController();
    this.cancelControllers.set(envelope.request_id, controller);
    try {
      const reply = await this.processControlRequest(envelope, controller.signal);
      if (this.cleanupPerformed) return;
      if (reply.suppress) return;
      const body = {
        type: "control_response",
        response: { subtype: "success", request_id: envelope.request_id, response: reply.response },
      };
      this.transport.write(`${JSON.stringify(body)}\n`);
    } catch (error) {
      if (this.cleanupPerformed) return;
      const body = {
        type: "control_response",
        response: { subtype: "error", request_id: envelope.request_id, error: errorMessage(error) },
      };
      try {
        this.transport.write(`${JSON.stringify(body)}\n`);
      } catch {
        /* the SDK only logs a failed error-response write */
      }
    } finally {
      this.cancelControllers.delete(envelope.request_id);
    }
  }

  private handleControlCancelRequest(requestId: string): void {
    const controller = this.cancelControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.cancelControllers.delete(requestId);
    }
  }

  private async processControlRequest(envelope: ControlRequestEnvelope, signal: AbortSignal): Promise<ControlReply> {
    const request = envelope.request;
    const subtype = request["subtype"];
    if (subtype === "can_use_tool") {
      const canUseTool = this.callbacks.canUseTool;
      if (!canUseTool) throw new Error("canUseTool callback is not provided.");
      const toolOptions: CanUseToolOptions = {
        signal,
        suggestions: request["permission_suggestions"] as CanUseToolOptions["suggestions"],
        blockedPath: stringField(request, "blocked_path"),
        decisionReason: stringField(request, "decision_reason"),
        title: stringField(request, "title"),
        displayName: stringField(request, "display_name"),
        description: stringField(request, "description"),
        toolUseID: request["tool_use_id"] as string,
        agentID: stringField(request, "agent_id"),
        requestId: envelope.request_id,
      };
      const rule = request["matched_ask_rule"];
      if (isObject(rule)) {
        const ruleContent = rule["rule_content"];
        toolOptions.matchedAskRule = {
          source: rule["source"],
          toolName: rule["tool_name"],
          ...(ruleContent !== undefined ? { ruleContent } : {}),
        } as CanUseToolOptions["matchedAskRule"];
      }
      const result: unknown = await canUseTool(
        request["tool_name"] as string,
        request["input"] as Record<string, unknown>,
        toolOptions
      );
      if (result === null) return { suppress: true };
      return { suppress: false, response: { ...(result as JsonObject), toolUseID: request["tool_use_id"] } };
    }
    if (subtype === "hook_callback") {
      const callbackId = request["callback_id"] as string;
      const callback = this.hookCallbacks.get(callbackId);
      if (!callback) throw new Error(`No hook callback found for ID: ${callbackId}`);
      // The input goes through untouched, as in the SDK: a cast to HookInput (a union of 31
      // object types) would make scriptc check the CLI's JSON against one of them.
      const passThrough = callback as unknown as RawHookCallback;
      const output = await passThrough(request["input"], request["tool_use_id"] as string | undefined, { signal });
      return { suppress: false, response: output };
    }
    if (subtype === "mcp_message") throw new Error(`SDK MCP server not found: ${String(request["server_name"])}`);
    if (subtype === "elicitation") {
      const onElicitation = this.callbacks.onElicitation;
      if (!onElicitation) return { suppress: false, response: { action: "decline" } };
      const result = await onElicitation(
        {
          serverName: request["mcp_server_name"],
          message: request["message"],
          mode: request["mode"],
          url: request["url"],
          elicitationId: request["elicitation_id"],
          requestedSchema: request["requested_schema"],
          title: request["title"],
          displayName: request["display_name"],
          description: request["description"],
        } as Parameters<OnElicitation>[0],
        { signal, requestId: envelope.request_id }
      );
      if (result === null) return { suppress: true };
      return { suppress: false, response: result };
    }
    if (subtype === "request_user_dialog") {
      const onUserDialog = this.callbacks.onUserDialog;
      if (!onUserDialog) return { suppress: true };
      const result = await onUserDialog(
        {
          dialogKind: request["dialog_kind"],
          payload: request["payload"],
          toolUseID: request["tool_use_id"],
        } as Parameters<OnUserDialog>[0],
        { signal, requestId: envelope.request_id }
      );
      if (result === null) return { suppress: true };
      return { suppress: false, response: result };
    }
    if (subtype === "oauth_token_refresh") throw new Error("getOAuthToken callback is not provided.");
    if (subtype === "host_auth_token_refresh") throw new Error("getHostAuthToken callback is not provided.");
    throw new Error(`Unsupported control request subtype: ${String(subtype)}`);
  }

  private async *readSdkMessages(): AsyncGenerator<SDKMessage, void, unknown> {
    try {
      for await (const message of this.inputStream) yield message;
    } finally {
      await this.cleanup();
    }
  }

  private async initialize(): Promise<InitializeResponse> {
    const hooks = this.callbacks.hooks;
    if (hooks && !this.initHooksPayload) {
      const payload: JsonObject = {};
      for (const [event, matchers] of Object.entries(hooks) as Array<[string, HookCallbackMatcher[]]>) {
        if (matchers.length === 0) continue;
        payload[event] = matchers.map((matcher) => {
          const ids: string[] = [];
          for (const hook of matcher.hooks) {
            const id = `hook_${this.nextCallbackId++}`;
            this.hookCallbacks.set(id, hook);
            ids.push(id);
          }
          return { matcher: matcher.matcher, hookCallbackIds: ids, timeout: matcher.timeout };
        });
      }
      this.initHooksPayload = payload;
    }
    const config = this.initConfig;
    const request: JsonObject = {
      subtype: "initialize",
      hooks: this.initHooksPayload,
      sdkMcpServers: undefined,
      jsonSchema: this.jsonSchema,
      systemPrompt: typeof config.systemPrompt === "string" ? [config.systemPrompt] : config.systemPrompt,
      appendSystemPrompt: config.appendSystemPrompt,
      planModeInstructions: config.planModeInstructions,
      appendSubagentSystemPrompt: undefined,
      toolAliases: config.toolAliases,
      excludeDynamicSections: config.excludeDynamicSections,
      agents: config.agents,
      title: config.title,
      skills: Array.isArray(config.skills) ? config.skills : undefined,
      webSearchIsolationExemptMcpServers: undefined,
      promptSuggestions: config.promptSuggestions,
      agentProgressSummaries: config.agentProgressSummaries,
      forwardSubagentText: config.forwardSubagentText,
      supportedDialogKinds: config.supportedDialogKinds,
      perTaskStopAffordance: config.perTaskStopAffordance,
    };
    return (await this.request(request)).response as unknown as InitializeResponse;
  }

  async interrupt(): Promise<InterruptResponse> {
    const result = await this.request({ subtype: "interrupt" });
    const stillQueued = result.response?.["still_queued"];
    if (!Array.isArray(stillQueued)) return undefined;
    const cancelled = result.response?.["cancelled"];
    return {
      still_queued: stillQueued.filter((entry): entry is string => typeof entry === "string"),
      ...(Array.isArray(cancelled)
        ? { cancelled: cancelled.filter((entry): entry is string => typeof entry === "string") }
        : {}),
    } as InterruptResponse;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.request({ subtype: "set_permission_mode", mode });
  }

  async setMcpPermissionModeOverride(
    serverName: string,
    mode: "default" | "auto" | null
  ): Promise<{ warning?: string }> {
    const result = await this.request({ subtype: "set_mcp_permission_mode_override", serverName, mode });
    return (result.response ?? {}) as { warning?: string };
  }

  async setModel(model?: string): Promise<void> {
    await this.request({ subtype: "set_model", model });
  }

  async setMaxThinkingTokens(
    maxThinkingTokens: number | null,
    thinkingDisplay?: "summarized" | "omitted" | null
  ): Promise<void> {
    await this.request({
      subtype: "set_max_thinking_tokens",
      max_thinking_tokens: maxThinkingTokens,
      thinking_display: thinkingDisplay,
    });
  }

  async applyFlagSettings(settings: ApplyFlagSettings): Promise<void> {
    await this.request({ subtype: "apply_flag_settings", settings });
  }

  async rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean }
  ): Promise<Awaited<ReturnType<Query["rewindFiles"]>>> {
    const result = await this.request({
      subtype: "rewind_files",
      user_message_id: userMessageId,
      dry_run: options?.dryRun,
    });
    return result.response as unknown as Awaited<ReturnType<Query["rewindFiles"]>>;
  }

  /** Not in the SDK's public Query type; Paseo reaches it through a cast. */
  async cancelAsyncMessage(messageUuid: string): Promise<boolean> {
    const result = await this.request({ subtype: "cancel_async_message", message_uuid: messageUuid });
    return result.response?.["cancelled"] as boolean;
  }

  async seedReadState(filePath: string, mtime: number): Promise<void> {
    await this.request({ subtype: "seed_read_state", path: filePath, mtime });
  }

  async stopTask(taskId: string): Promise<void> {
    await this.request({ subtype: "stop_task", task_id: taskId });
  }

  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    const result = await this.request({ subtype: "background_tasks", tool_use_id: toolUseId });
    return (result.response?.["backgrounded"] as boolean | undefined) ?? true;
  }

  private processPendingRequests(requests: ControlRequestEnvelope[], subtype: string): void {
    for (const request of requests)
      if (request.request["subtype"] === subtype)
        this.handleControlRequest(request).catch(() => {
          /* handleControlRequest reports its own failures to the CLI */
        });
  }

  private request(body: JsonObject): Promise<ControlResponse> {
    const requestId = Math.random().toString(REQUEST_ID_RADIX).substring(REQUEST_ID_START, REQUEST_ID_END);
    const envelope = { request_id: requestId, type: "control_request", request: body };
    const isInitialize = body["subtype"] === "initialize";
    return new Promise((resolve, reject) => {
      this.pendingControlResponses.set(requestId, {
        handler: (response) => {
          this.pendingControlResponses.delete(requestId);
          if (response.subtype === "success") resolve(response);
          else
            reject(
              new TaggedError(String(response.error), {
                telemetryMessage: `Claude Code control request failed (${String(body["subtype"])})`,
                errorClass: "control_request_failed",
              })
            );
          if (!isInitialize && (response.pending_permission_requests || response.pending_user_dialog_requests)) return;
          if (response.pending_permission_requests)
            this.processPendingRequests(response.pending_permission_requests, "can_use_tool");
          if (response.pending_user_dialog_requests)
            this.processPendingRequests(response.pending_user_dialog_requests, "request_user_dialog");
        },
        reject,
      });
      this.transport.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  initializationResult(): Promise<InitializeResponse> {
    return this.initialization;
  }

  reinitialize(): Promise<InitializeResponse> {
    return this.initialize();
  }

  async supportedCommands(): Promise<Awaited<ReturnType<Query["supportedCommands"]>>> {
    const { commands } = await this.initialization;
    return (this.latestCommands as typeof commands | undefined) ?? commands;
  }

  async supportedModels(): Promise<Awaited<ReturnType<Query["supportedModels"]>>> {
    return (await this.initialization).models;
  }

  async supportedAgents(): Promise<Awaited<ReturnType<Query["supportedAgents"]>>> {
    return (await this.initialization).agents;
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.request({ subtype: "mcp_reconnect", serverName });
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.request({ subtype: "mcp_toggle", serverName, enabled });
  }

  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<Awaited<ReturnType<Query["setMcpServers"]>>> {
    for (const config of Object.values(servers))
      if (config.type === "sdk") throw new Error("SDK MCP servers are not supported by the native SDK stand-in");
    const result = await this.request({ subtype: "mcp_set_servers", servers: { ...servers } });
    return result.response as unknown as Awaited<ReturnType<Query["setMcpServers"]>>;
  }

  async mcpServerStatus(): Promise<Awaited<ReturnType<Query["mcpServerStatus"]>>> {
    const result = await this.request({ subtype: "mcp_status" });
    return result.response?.["mcpServers"] as Awaited<ReturnType<Query["mcpServerStatus"]>>;
  }

  async getContextUsage(): Promise<Awaited<ReturnType<Query["getContextUsage"]>>> {
    return (await this.request({ subtype: "get_context_usage" })).response as unknown as Awaited<
      ReturnType<Query["getContextUsage"]>
    >;
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<
    Awaited<ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>>
  > {
    return (await this.request({ subtype: "get_usage" })).response as unknown as Awaited<
      ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>
    >;
  }

  async readFile(
    filePath: string,
    options?: { maxBytes?: number; encoding?: "utf-8" | "base64" }
  ): Promise<Awaited<ReturnType<Query["readFile"]>>> {
    try {
      const result = await this.request({
        subtype: "read_file",
        path: filePath,
        max_bytes: options?.maxBytes,
        encoding: options?.encoding,
      });
      return result.response as unknown as Awaited<ReturnType<Query["readFile"]>>;
    } catch {
      return null;
    }
  }

  async reloadPlugins(): Promise<Awaited<ReturnType<Query["reloadPlugins"]>>> {
    return (await this.request({ subtype: "reload_plugins" })).response as unknown as Awaited<
      ReturnType<Query["reloadPlugins"]>
    >;
  }

  async reloadSkills(): Promise<Awaited<ReturnType<Query["reloadSkills"]>>> {
    return (await this.request({ subtype: "reload_skills" })).response as unknown as Awaited<
      ReturnType<Query["reloadSkills"]>
    >;
  }

  async accountInfo(): Promise<Awaited<ReturnType<Query["accountInfo"]>>> {
    return (await this.initialization).account;
  }

  async streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      let count = 0;
      for await (const message of stream) {
        count++;
        if (this.abortController.signal.aborted) break;
        this.transport.write(`${JSON.stringify(message)}\n`);
      }
      if (count > 0 && this.hasBidirectionalNeeds()) await this.waitForFirstResult();
      this.transport.endInput();
    } catch (error) {
      if (!(error instanceof AbortError)) throw error;
    }
  }

  private waitForFirstResult(): Promise<void> {
    if (this.firstResultReceived) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = this.abortController.signal;
      if (this.cleanupPerformed || signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      this.addCleanupCallback(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      this.firstResultReceivedResolve = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
  }

  /** Writes a plain-text prompt (query() with a string prompt). */
  writeUserText(text: string): void {
    const message = {
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
    this.transport.write(`${JSON.stringify(message)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// query()

function canUseToolShadowWarning(mode: string, allowedTools: string[]): string | undefined {
  if (mode === "bypassPermissions")
    return "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.";
  const bare = allowedTools.filter((tool) => tool.length > 0 && !tool.includes("("));
  if (bare.length === 0) return undefined;
  return `canUseTool will not be invoked for: ${bare.join(
    ", "
  )}. Bare allowedTools entries auto-approve the whole tool before the callback is consulted. To gate every tool call, use a PreToolUse hook; or remove the bare names from allowedTools so they fall through to canUseTool. Allow rules from settings files can also shadow the callback but are not visible here.`;
}

function bundledExecutablePath(): string {
  const candidates =
    process.platform === "linux"
      ? [`${SDK_PACKAGE}-linux-${process.arch}`, `${SDK_PACKAGE}-linux-${process.arch}-musl`]
      : [`${SDK_PACKAGE}-${process.platform}-${process.arch}`];
  const suffix = process.platform === "win32" ? ".exe" : "";
  // The SDK uses createRequire(import.meta.url).resolve(); scriptc cannot resolve a computed
  // request, so this walks the node_modules directories above this file the same way. The
  // platform packages declare no `exports`, so the walk finds what require.resolve would.
  for (const candidate of candidates) {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const binary = path.join(dir, "node_modules", candidate, `claude${suffix}`);
      if (existsSync(binary)) return realpathSync(binary);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(
    `Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`
  );
}

function thinkingConfigFrom(options: Options): ThinkingConfig | undefined {
  const thinking = options.thinking;
  if (thinking) {
    if (thinking.type === "adaptive") return { type: "adaptive", display: thinking.display };
    if (thinking.type === "enabled")
      return { type: "enabled", budgetTokens: thinking.budgetTokens, display: thinking.display };
    return { type: "disabled" };
  }
  const maxThinkingTokens = options.maxThinkingTokens;
  if (maxThinkingTokens === undefined) return undefined;
  return maxThinkingTokens === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: maxThinkingTokens };
}

export function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const prompt = params.prompt;
  const options: Options = params.options ?? {};
  if (options.sessionStore)
    throw new Error("Options.sessionStore is not supported by the native claude-agent-sdk stand-in");
  const systemPrompt = options.systemPrompt;
  let initSystemPrompt: string | string[] | undefined;
  let appendSystemPrompt: string | undefined;
  let excludeDynamicSections: boolean | undefined;
  if (systemPrompt === undefined) initSystemPrompt = "";
  else if (typeof systemPrompt === "string" || Array.isArray(systemPrompt)) initSystemPrompt = systemPrompt;
  else if (systemPrompt.type === "preset") {
    appendSystemPrompt = systemPrompt.append;
    excludeDynamicSections = systemPrompt.excludeDynamicSections;
  }
  process.env["CLAUDE_AGENT_SDK_VERSION"] = SDK_VERSION;
  const abortController = options.abortController ?? createAbortController();
  const allowedTools = options.allowedTools ?? [];
  const permissionMode = options.permissionMode ?? "default";
  if (options.supportedDialogKinds !== undefined && options.supportedDialogKinds.length > 0 && !options.onUserDialog)
    throw new Error(
      "supportedDialogKinds requires an onUserDialog callback -- declaring dialog kinds without a handler would park dialogs nothing can answer. Provide onUserDialog, or omit supportedDialogKinds."
    );
  if (options.canUseTool) {
    const warning = canUseToolShadowWarning(permissionMode, allowedTools);
    if (warning !== undefined) process.emitWarning(warning, { code: "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" });
  }
  const executablePath = options.pathToClaudeCodeExecutable || bundledExecutablePath();
  const outputFormat = options.outputFormat;
  const jsonSchema = outputFormat?.type === "json_schema" ? outputFormat.schema : undefined;
  const env: Env = options.env ? { ...options.env } : { ...process.env };
  if (!env["CLAUDE_CODE_ENTRYPOINT"]) env["CLAUDE_CODE_ENTRYPOINT"] = SDK_ENTRYPOINT;
  if (!env["CLAUDE_AGENT_SDK_VERSION"]) env["CLAUDE_AGENT_SDK_VERSION"] = SDK_VERSION;
  if (options.enableFileCheckpointing) env["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"] = "true";
  const previewFormat = options.toolConfig?.askUserQuestion?.previewFormat;
  if (previewFormat) env["CLAUDE_CODE_QUESTION_PREVIEW_FORMAT"] = previewFormat;
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(options.mcpServers ?? {})) {
    if (config.type === "sdk" && "instance" in config && config.instance)
      throw new Error("SDK MCP servers are not supported by the native claude-agent-sdk stand-in");
    mcpServers[name] = config;
  }
  const settings = options.settings;
  const transport = new ProcessTransport({
    abortController,
    additionalDirectories: options.additionalDirectories ?? [],
    agent: options.agent,
    betas: options.betas,
    cwd: options.cwd,
    debug: options.debug,
    debugFile: options.debugFile,
    executable: options.executable ?? (process.versions["bun"] !== undefined ? "bun" : "node"),
    executableArgs: options.executableArgs ?? [],
    extraArgs: options.extraArgs ?? {},
    pathToClaudeCodeExecutable: executablePath,
    env,
    forkSession: options.forkSession,
    stderr: options.stderr,
    thinkingConfig: thinkingConfigFrom(options),
    effort: options.effort,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    taskBudget: options.taskBudget,
    model: options.model,
    fallbackModel: options.fallbackModel,
    jsonSchema,
    permissionMode,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? false,
    permissionPromptToolName: options.permissionPromptToolName,
    continueConversation: options.continue,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    resumeDropsTurn: options.resumeDropsTurn,
    sessionId: options.sessionId,
    settings: typeof settings === "object" ? JSON.stringify(settings) : settings,
    managedSettings: options.managedSettings ? JSON.stringify(options.managedSettings) : undefined,
    settingSources: options.settingSources,
    skills: options.skills,
    allowedTools,
    disallowedTools: options.disallowedTools ?? [],
    tools: options.tools,
    mcpServers,
    strictMcpConfig: options.strictMcpConfig,
    canUseTool: !!options.canUseTool,
    includeHookEvents: options.includeHookEvents,
    includePartialMessages: options.includePartialMessages,
    persistSession: options.persistSession,
    plugins: options.plugins,
    sandbox: options.sandbox,
    spawnClaudeCodeProcess: options.spawnClaudeCodeProcess,
  });
  const nativeQuery = new NativeQuery(
    transport,
    typeof prompt === "string",
    {
      canUseTool: options.canUseTool,
      hooks: options.hooks,
      onElicitation: options.onElicitation,
      onUserDialog: options.onUserDialog,
    },
    abortController,
    jsonSchema,
    {
      systemPrompt: initSystemPrompt,
      appendSystemPrompt,
      planModeInstructions: options.planModeInstructions,
      toolAliases: options.toolAliases,
      excludeDynamicSections,
      agents: options.agents,
      title: options.title,
      skills: options.skills,
      promptSuggestions: options.promptSuggestions,
      agentProgressSummaries: options.agentProgressSummaries,
      forwardSubagentText: options.forwardSubagentText,
      supportedDialogKinds: options.supportedDialogKinds,
      perTaskStopAffordance: options.perTaskStopAffordance,
    }
  );
  if (typeof prompt === "string") nativeQuery.writeUserText(prompt);
  else nativeQuery.streamInput(prompt).catch((error: unknown) => abortController.abort(error));
  return nativeQuery;
}

// ---------------------------------------------------------------------------------------------
// forkSession()

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_TYPES = new Set(["user", "assistant", "attachment", "system", "progress"]);
const PROJECT_DIR_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const COMMAND_NAME_PATTERN = /<command-name>(.*?)<\/command-name>/;
const BASH_INPUT_PATTERN = /<bash-input>([\s\S]*?)<\/bash-input>/;
const NOT_A_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

interface ParsedTranscript {
  transcript: JsonObject[];
  contentReplacements: unknown[];
  relocatedCwd: string | undefined;
  historySuppressed: boolean;
  atisLatch: string | undefined;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function validateForkIds(sessionId: string, upToMessageId: string | undefined, reason: string): void {
  if (!isUuid(sessionId))
    throw new TelemetrySafeError(`Invalid sessionId: ${sessionId}`, `forkSession: invalid sessionId (${reason})`);
  if (upToMessageId && !isUuid(upToMessageId))
    throw new TelemetrySafeError(
      `Invalid upToMessageId: ${upToMessageId}`,
      `forkSession: invalid upToMessageId (${reason})`
    );
}

function normalizeForPlatform(value: string): string {
  return process.platform === "darwin" ? value.normalize("NFC") : value;
}

function configDir(): string {
  return (process.env["CLAUDE_CONFIG_DIR"] ?? path.join(homedir(), ".claude")).normalize("NFC");
}

function projectsDir(): string {
  return path.join(configDir(), "projects");
}

function sanitizePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

function stringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return hash;
}

function projectDirName(projectPath: string): string {
  const sanitized = sanitizePath(projectPath);
  if (sanitized.length <= PROJECT_KEY_MAX) return sanitized;
  return `${sanitized.slice(0, PROJECT_KEY_MAX)}-${Math.abs(stringHash(projectPath)).toString(36)}`;
}

function projectDirNameOverride(): string | undefined {
  if (!process.env["CLAUDE_CONFIG_DIR"]) return undefined;
  const name = process.env["CLAUDE_CODE_PROJECT_DIR_NAME"];
  if (!name || !PROJECT_DIR_NAME_PATTERN.test(name) || RESERVED_DEVICE_NAME.test(name)) return undefined;
  return name;
}

function projectKey(projectPath: string): string {
  return projectDirNameOverride() ?? projectDirName(projectPath);
}

/** The project key a session store sees for `dir` (default: the current directory). */
function storeProjectKey(dir: string | undefined): string {
  const resolved = path.resolve(dir ?? ".");
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  return projectKey(normalizeForPlatform(real));
}

function collectTranscriptEntry(entry: JsonObject, sessionId: string, parsed: ParsedTranscript): void {
  const type = entry["type"];
  if (typeof type === "string" && TRANSCRIPT_TYPES.has(type) && typeof entry["uuid"] === "string") {
    parsed.transcript.push(entry);
  } else if (type === "history-suppression") {
    parsed.historySuppressed = true;
  } else if (
    type === "atis-latch" &&
    entry["sessionId"] === sessionId &&
    typeof entry["atis"] === "string" &&
    /^[\x21-\x7e]*$/.test(entry["atis"])
  ) {
    parsed.atisLatch = entry["atis"];
  } else if (
    type === "content-replacement" &&
    entry["sessionId"] === sessionId &&
    Array.isArray(entry["replacements"])
  ) {
    parsed.contentReplacements.push(...(entry["replacements"] as unknown[]));
  } else if (
    type === "relocated" &&
    entry["sessionId"] === sessionId &&
    typeof entry["relocatedCwd"] === "string" &&
    entry["relocatedCwd"] !== ""
  ) {
    parsed.relocatedCwd = entry["relocatedCwd"];
  }
}

function emptyTranscript(): ParsedTranscript {
  return {
    transcript: [],
    contentReplacements: [],
    relocatedCwd: undefined,
    historySuppressed: false,
    atisLatch: undefined,
  };
}

function parseTranscriptEntries(entries: SessionStoreEntry[], sessionId: string): ParsedTranscript {
  const parsed = emptyTranscript();
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    collectTranscriptEntry(entry, sessionId, parsed);
  }
  return parsed;
}

function parseTranscriptBuffer(buffer: Buffer, sessionId: string): ParsedTranscript {
  const parsed = emptyTranscript();
  let offset = 0;
  while (offset < buffer.length) {
    let lineEnd = buffer.indexOf(10, offset);
    if (lineEnd === -1) lineEnd = buffer.length;
    let start = offset;
    while (start < lineEnd && (buffer[start] ?? 0) <= 32) start++;
    offset = lineEnd + 1;
    if (start >= lineEnd) continue;
    try {
      const value: unknown = JSON.parse(buffer.toString("utf-8", start, lineEnd));
      if (value === null) continue;
      if (isObject(value)) collectTranscriptEntry(value, sessionId, parsed);
    } catch {
      /* the SDK skips a transcript line that is not JSON */
    }
  }
  return parsed;
}

/** The fork's entries: new UUIDs, parent links remapped past progress entries. */
function buildFork(
  parsed: ParsedTranscript,
  sessionId: string,
  options: ForkSessionOptions,
  fallbackTitle: () => string | undefined
): { entries: JsonObject[]; forkedSessionId: string } {
  let transcript = parsed.transcript.filter((entry) => !entry["isSidechain"]);
  if (transcript.length === 0) throw new Error(`Session ${sessionId} has no messages to fork`);
  const upToMessageId = options.upToMessageId;
  if (upToMessageId) {
    const index = transcript.findIndex((entry) => entry["uuid"] === upToMessageId);
    if (index === -1) throw new Error(`Message ${upToMessageId} not found in session ${sessionId}`);
    transcript = transcript.slice(0, index + 1);
  }
  const newIds = new Map<string, string>();
  for (const entry of transcript) newIds.set(entry["uuid"] as string, randomUUID());
  const kept = transcript.filter((entry) => entry["type"] !== "progress");
  if (kept.length === 0) throw new Error(`Session ${sessionId} has no messages to fork`);
  const byId = new Map<string, JsonObject>();
  for (const entry of transcript) byId.set(entry["uuid"] as string, entry);
  const forkedSessionId = randomUUID();
  const now = new Date().toISOString();
  const entries: JsonObject[] = [];
  if (parsed.historySuppressed)
    entries.push({
      type: "history-suppression",
      sessionId: forkedSessionId,
      cause: "fork_inherit",
      ts: new Date().toISOString(),
    });
  for (let i = 0; i < kept.length; i++) {
    const entry = kept[i] as JsonObject;
    const originalId = entry["uuid"] as string;
    let parentId: string | null = null;
    let cursor = entry["parentUuid"];
    while (typeof cursor === "string" && cursor) {
      const parent = byId.get(cursor);
      if (!parent) break;
      if (parent["type"] !== "progress") {
        parentId = newIds.get(cursor) ?? null;
        break;
      }
      cursor = parent["parentUuid"];
    }
    const logicalParent = entry["logicalParentUuid"];
    const logicalParentUuid =
      logicalParent === null || logicalParent === undefined
        ? logicalParent
        : newIds.get(logicalParent as string) ?? null;
    const neutralized =
      entry["type"] === "system" && entry["subtype"] === "model_refusal_fallback" ? { neutralizedByFork: true } : {};
    entries.push({
      ...entry,
      ...neutralized,
      uuid: newIds.get(originalId),
      parentUuid: parentId,
      logicalParentUuid,
      sessionId: forkedSessionId,
      timestamp: i === kept.length - 1 ? now : (entry["timestamp"] as string | undefined),
      isSidechain: false,
      teamName: undefined,
      agentName: undefined,
      sessionKind: undefined,
      slug: undefined,
      sourceToolAssistantUUID: undefined,
      forkedFrom: { sessionId, messageUuid: originalId },
    });
  }
  if (parsed.contentReplacements.length > 0)
    entries.push({
      type: "content-replacement",
      sessionId: forkedSessionId,
      replacements: parsed.contentReplacements,
      uuid: randomUUID(),
      timestamp: now,
    });
  if (parsed.atisLatch !== undefined)
    entries.push({ type: "atis-latch", sessionId: forkedSessionId, atis: parsed.atisLatch });
  if (parsed.relocatedCwd)
    entries.push({ type: "relocated", sessionId: forkedSessionId, relocatedCwd: parsed.relocatedCwd });
  let title = options.title?.trim();
  if (!title) title = `${fallbackTitle() || "Forked session"} (fork)`;
  entries.push({
    type: "custom-title",
    sessionId: forkedSessionId,
    customTitle: title,
    uuid: randomUUID(),
    timestamp: now,
  });
  return { entries, forkedSessionId };
}

/** The first prompt of a transcript entry, as the SDK titles sessions; undefined to keep looking. */
function firstPromptOf(entry: JsonObject, state: { commandFallback: string }): string | undefined {
  if (entry["type"] !== "user") return undefined;
  if (entry["isMeta"] === true || entry["isCompactSummary"] === true) return undefined;
  const message = entry["message"];
  if (!isObject(message)) return undefined;
  const content = message["content"];
  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      if (!isObject(block)) continue;
      if (block["type"] === "tool_result") return undefined;
      if (block["type"] === "text" && typeof block["text"] === "string") texts.push(block["text"]);
    }
  }
  for (const raw of texts) {
    let text = raw.replaceAll("\n", " ").trim();
    if (!text) continue;
    const command = COMMAND_NAME_PATTERN.exec(text);
    if (command) {
      if (!state.commandFallback) state.commandFallback = command[1] ?? "";
      continue;
    }
    const bash = BASH_INPUT_PATTERN.exec(text);
    if (bash) return `! ${(bash[1] ?? "").trim()}`;
    if (NOT_A_PROMPT_PATTERN.test(text)) continue;
    if (text.length > FIRST_PROMPT_MAX) text = `${head(text, FIRST_PROMPT_MAX).trim()}\u2026`;
    return text;
  }
  return undefined;
}

function firstPromptOfEntries(entries: SessionStoreEntry[]): string {
  const state = { commandFallback: "" };
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const prompt = firstPromptOf(entry, state);
    if (prompt !== undefined) return prompt;
  }
  return state.commandFallback;
}

function firstPromptOfText(text: string): string {
  const state = { commandFallback: "" };
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const line = newline >= 0 ? text.slice(offset, newline) : text.slice(offset);
    offset = newline >= 0 ? newline + 1 : text.length;
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    if (line.includes('"tool_result"')) continue;
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
    if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) continue;
      const prompt = firstPromptOf(value, state);
      if (prompt !== undefined) return prompt;
    } catch {
      continue;
    }
  }
  return state.commandFallback;
}

function unescapeJsonString(value: string): string {
  if (!value.includes("\\")) return value;
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/** The value of the last `"key":"..."` occurrence in raw JSONL text. */
function lastStringField(text: string, key: string): string | undefined {
  let found: string | undefined;
  let foundAt = -1;
  for (const marker of [`"${key}":"`, `"${key}": "`]) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at < 0) break;
      const start = at + marker.length;
      let end = start;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          if (at > foundAt) {
            found = unescapeJsonString(text.slice(start, end));
            foundAt = at;
          }
          break;
        }
        end++;
      }
      from = end + 1;
    }
  }
  return found;
}

function lastTitleOfEntries(entries: SessionStoreEntry[]): string | undefined {
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const custom = entry["customTitle"];
    const ai = entry["aiTitle"];
    if (typeof custom === "string" && custom) customTitle = custom;
    if (typeof ai === "string" && ai) aiTitle = ai;
  }
  return customTitle || aiTitle || firstPromptOfEntries(entries) || undefined;
}

function sanitizeCustomTitle(value: string): string {
  const spaced = value.trim().replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ");
  return [...spaced.replace(/[\x00-\x1f\x7f-\x9f]/g, "")].slice(0, CUSTOM_TITLE_MAX).join("").trim();
}

/** The title in `<projectDir>/<sessionId>/custom-title.json`, when present and valid. */
async function readSidecarTitle(transcriptPath: string, sessionId: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(path.dirname(transcriptPath), sessionId, "custom-title.json"), "utf8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || typeof value["customTitle"] !== "string") return undefined;
  return sanitizeCustomTitle(value["customTitle"]) || undefined;
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

/** Project directories that may hold sessions of `projectPath`. */
async function projectDirsFor(projectPath: string): Promise<string[]> {
  const primary = path.join(projectsDir(), projectKey(projectPath));
  const dirs: string[] = [];
  if (await directoryExists(primary)) dirs.push(primary);
  const plain = projectDirName(projectPath);
  if (plain !== projectKey(projectPath)) {
    const alternate = path.join(projectsDir(), plain);
    if (await directoryExists(alternate)) dirs.push(alternate);
  }
  return dirs;
}

async function realpathOrSelf(value: string): Promise<string> {
  try {
    return normalizeForPlatform(await realpath(value));
  } catch {
    return normalizeForPlatform(value);
  }
}

function gitWorktrees(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    // The SDK passes execFile's `timeout` option, which scriptc does not lower; this timer
    // does what that option does (SIGTERM, then the callback sees an error).
    const child = execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "worktree", "list", "--porcelain"],
      { cwd, windowsHide: true },
      (error, stdout) => {
        clearTimeout(timer);
        if (error || !stdout) {
          resolve([]);
          return;
        }
        resolve(
          String(stdout)
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => normalizeForPlatform(line.slice("worktree ".length)))
        );
      }
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), GIT_TIMEOUT_MS);
  });
}

async function readSessionIn(
  projectDir: string,
  sessionId: string
): Promise<{ buffer: Buffer; projectDir: string } | null> {
  try {
    const buffer = await readFile(path.join(projectDir, `${sessionId}.jsonl`));
    if (buffer.length === 0) return null;
    return { buffer, projectDir };
  } catch {
    return null;
  }
}

async function findSessionFile(
  sessionId: string,
  dir: string | undefined
): Promise<{ buffer: Buffer; projectDir: string } | null> {
  if (dir) {
    const projectPath = await realpathOrSelf(dir);
    for (const projectDir of await projectDirsFor(projectPath)) {
      const found = await readSessionIn(projectDir, sessionId);
      if (found) return found;
    }
    for (const worktree of await gitWorktrees(projectPath)) {
      if (worktree === projectPath) continue;
      for (const projectDir of await projectDirsFor(worktree)) {
        const found = await readSessionIn(projectDir, sessionId);
        if (found) return found;
      }
    }
    return null;
  }
  const root = projectsDir();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const found = await readSessionIn(path.join(root, name), sessionId);
    if (found) return found;
  }
  return null;
}

async function forkSessionInStore(
  store: SessionStore,
  sessionId: string,
  options: ForkSessionOptions
): Promise<ForkSessionResult> {
  validateForkIds(sessionId, options.upToMessageId, "must be a UUID");
  const projectKeyValue = storeProjectKey(options.dir);
  const source: SessionKey = { projectKey: projectKeyValue, sessionId };
  const entries = await store.load(source);
  if (!entries || entries.length === 0) throw new Error(`Session ${sessionId} not found`);
  const fork = buildFork(parseTranscriptEntries(entries, sessionId), sessionId, options, () =>
    lastTitleOfEntries(entries)
  );
  await store.append(
    { projectKey: projectKeyValue, sessionId: fork.forkedSessionId },
    fork.entries as unknown as SessionStoreEntry[]
  );
  return { sessionId: fork.forkedSessionId };
}

async function forkSessionOnDisk(sessionId: string, options: ForkSessionOptions): Promise<ForkSessionResult> {
  validateForkIds(sessionId, options.upToMessageId, "not a UUID");
  const found = await findSessionFile(sessionId, options.dir);
  if (!found)
    throw new Error(
      options.dir
        ? `Session ${sessionId} not found in project directory for ${options.dir}`
        : `Session ${sessionId} not found`
    );
  const sidecarTitle = await readSidecarTitle(path.join(found.projectDir, `${sessionId}.jsonl`), sessionId);
  const buffer = found.buffer;
  const fork = buildFork(parseTranscriptBuffer(buffer, sessionId), sessionId, options, () => {
    const headText = buffer.toString("utf-8", 0, Math.min(buffer.length, TITLE_SCAN_BYTES));
    const tailText = buffer.toString("utf-8", Math.max(0, buffer.length - TITLE_SCAN_BYTES));
    const lastCustom = lastStringField(tailText, "customTitle");
    return (
      (lastCustom !== undefined ? lastCustom : sidecarTitle ?? lastStringField(headText, "customTitle")) ||
      lastStringField(tailText, "aiTitle") ||
      lastStringField(headText, "aiTitle") ||
      firstPromptOfText(headText)
    );
  });
  const lines = fork.entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  await writeFile(path.join(found.projectDir, `${fork.forkedSessionId}.jsonl`), lines, {
    mode: TRANSCRIPT_FILE_MODE,
  });
  return { sessionId: fork.forkedSessionId };
}

export async function forkSession(sessionId: string, options?: ForkSessionOptions): Promise<ForkSessionResult> {
  if (options?.sessionStore) return forkSessionInStore(options.sessionStore, sessionId, options);
  return forkSessionOnDisk(sessionId, options ?? {});
}
