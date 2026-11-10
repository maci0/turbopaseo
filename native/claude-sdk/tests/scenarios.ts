// Scenario suite run against the real SDK (tests/run-sdk.ts) and against this module
// (tests/run-native.ts, under Node and as a scriptc binary). Each scenario drives `query`
// against tests/fake-claude.ts and prints what the caller observes (messages, callback
// arguments, errors) followed by what the fake CLI recorded (argv, environment, stdin
// lines, signals). The three outputs must be identical.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
  ForkSessionOptions,
  ForkSessionResult,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

export type QueryFunction = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
export type ForkSessionFunction = (sessionId: string, options?: ForkSessionOptions) => Promise<ForkSessionResult>;

type Json = { [key: string]: unknown };
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

const SCENARIO_TIMEOUT_MS = 20_000;
const CLI_LOG_WAIT_MS = 15_000;
const POLL_MS = 20;
const RESUME_ID = "11111111-1111-4111-8111-111111111111";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(testsDir, "fake-claude");
const fakeScript = path.join(testsDir, "fake-claude.ts");

let outDir = "";
const lines: string[] = [];

/** SCENARIO_TRACE=1 also prints each line to stderr as it happens. */
const trace = process.env["SCENARIO_TRACE"] === "1";

function log(line: string): void {
  const normalized = line.split(testsDir).join("<TESTS>").split(outDir).join("<OUT>");
  lines.push(normalized);
  if (trace) process.stderr.write(`${normalized.slice(0, 200)}\n`);
}

/**
 * The SDK raises "Operation aborted" when it sees stdout end before the abort-time exit and
 * "Claude Code process aborted by user" when it sees the exit first. A child under scriptc
 * reports both at once in the other order from Node (see README), so a scenario that races
 * them sets this and both read as one.
 */
let abortErrorsEquivalent = false;
const SDK_ABORT_MESSAGES = new Set(["Operation aborted", "Claude Code process aborted by user"]);

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (abortErrorsEquivalent && SDK_ABORT_MESSAGES.has(error.message)) return `${error.name}: <SDK abort error>`;
    return `${error.name}: ${error.message}`;
  }
  return `thrown ${JSON.stringify(error)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`scenario timed out after ${ms} ms`)), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** An async iterable of user messages the scenario pushes and ends, like Paseo's input. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage, undefined>) => void) | undefined;
  private ended = false;

  push(text: string): void {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ done: false, value: message });
    } else this.items.push(message);
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<SDKUserMessage, undefined>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

/** Node's spawn() `signal` behaviour without the option: SIGTERM and 'error' on abort. */
class AbortedSpawnError extends Error {
  constructor() {
    super("The operation was aborted");
    this.name = "AbortError";
  }
}

/**
 * A ChildProcess behind the SDK's SpawnedProcess interface, the shape Paseo's spawner would
 * return natively (scriptc cannot pass a ChildProcess where SpawnedProcess is declared).
 */
class SpawnedChild implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();

  constructor(child: ChildProcessWithoutNullStreams, signal: AbortSignal) {
    this.child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    child.on("exit", (code: number | null, exitSignal: NodeJS.Signals | null) =>
      this.events.emit("exit", code, exitSignal)
    );
    child.on("error", (error: Error) => this.events.emit("error", error));
    const onAbort = (): void => {
      if (child.kill("SIGTERM")) this.events.emit("error", new AbortedSpawnError());
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

function describeSpawn(options: SpawnOptions): string {
  const env = options.env;
  const keys = Object.keys(env).sort();
  return JSON.stringify({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    envKeys: keys,
    entrypoint: env["CLAUDE_CODE_ENTRYPOINT"],
    nodeOptions: env["NODE_OPTIONS"] ?? null,
    signalAborted: options.signal.aborted,
  });
}

function paseoSpawner(stderr: (data: string) => void): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    log(`spawner ${describeSpawn(options)}`);
    const cwd = options.cwd ?? process.cwd();
    const child = spawn(options.command, options.args, { cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (chunk: Buffer) => stderr(chunk.toString()));
    return new SpawnedChild(child, options.signal);
  };
}

function cliLogPath(name: string): string {
  return path.join(outDir, `${name}.cli.jsonl`);
}

function fakeEnv(name: string, scenario: string): { [key: string]: string | undefined } {
  return {
    PATH: process.env["PATH"],
    HOME: outDir,
    FAKE_CLI_LOG: cliLogPath(name),
    FAKE_CLI_SCENARIO: scenario,
    FAKE_MARK: "1",
    NODE_OPTIONS: "--trace-warnings",
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  };
}

const canUseTool = async (
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<NonNullable<Options["canUseTool"]>>[2]
): Promise<PermissionResult> => {
  log(
    `canUseTool ${toolName} ${JSON.stringify(input)} ${JSON.stringify({
      ...options,
      signal: options.signal.aborted ? "aborted" : "live",
      requestId: options.requestId === undefined ? "missing" : "present",
    })}`
  );
  if (toolName === "Explode") throw new Error("permission handler exploded");
  if (toolName === "Slow") {
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    log(`canUseTool Slow signal ${options.signal.aborted ? "aborted" : "live"}`);
    return { behavior: "deny", message: "cancelled" };
  }
  return { behavior: "allow", updatedInput: { ...input, checked: true } };
};

/** Typed like Paseo's hook (input: unknown); assignable to HookCallback. */
const hook = async (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
): Promise<{ continue: boolean; suppressOutput: boolean }> => {
  log(`hook ${JSON.stringify(input)} ${String(toolUseID)} ${options.signal.aborted ? "aborted" : "live"}`);
  return { continue: true, suppressOutput: false };
};

function paseoOptions(name: string, scenario: string, stderr: (data: string) => void): Options {
  return {
    cwd: testsDir,
    includePartialMessages: true,
    permissionMode: "default",
    allowDangerouslySkipPermissions: true,
    agents: { helper: { description: "Helps", prompt: "You help." } },
    canUseTool,
    pathToClaudeCodeExecutable: fakeCli,
    systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
    settingSources: ["user", "project", "local"],
    stderr,
    enableFileCheckpointing: true,
    resume: RESUME_ID,
    thinking: { type: "adaptive", display: "summarized" },
    effort: "high",
    allowedTools: ["mcp__paseo__list", "Bash(ls:*)"],
    disallowedTools: ["WebFetch"],
    additionalDirectories: ["/extra/dir"],
    extraArgs: { "debug-to-stderr": null, flag: "-dash" },
    sandbox: { enabled: true, network: { allowedDomains: ["example.com"] } },
    // Keys in the order the SDK types declare them: scriptc serializes a typed record in that
    // order, Node in insertion order (see README).
    settings: { permissions: { allow: ["Read"] }, fastMode: true },
    forwardSubagentText: true,
    perTaskStopAffordance: true,
    hooks: {
      PreToolUse: [{ hooks: [hook] }],
      PostToolUse: [{ hooks: [hook] }],
      SubagentStop: [{ matcher: "x", hooks: [hook], timeout: 5 }],
      Stop: [],
    },
    persistSession: true,
    env: fakeEnv(name, scenario),
    mcpServers: {
      paseo: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { a: "b" } },
      fs: { type: "stdio", command: "fs-mcp", args: ["--x"], env: {} },
    },
    model: "sonnet",
    spawnClaudeCodeProcess: paseoSpawner(stderr),
  };
}

function logMessage(message: SDKMessage): void {
  log(`message ${JSON.stringify(message)}`);
}

/** Iterates the query, logging messages, until done or an error; `onMessage` may stop it. */
async function pump(q: Query, onMessage?: (message: SDKMessage) => Promise<boolean>): Promise<void> {
  try {
    for await (const message of q) {
      logMessage(message);
      if (onMessage && (await onMessage(message))) {
        log("pump: break");
        break;
      }
    }
    log("pump: done");
  } catch (error) {
    log(`pump: error ${describeError(error)}`);
  }
}

async function call(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    const value = await work();
    log(`${label} -> ${value === undefined ? "undefined" : JSON.stringify(value)}`);
  } catch (error) {
    log(`${label} threw ${describeError(error)}`);
  }
}

/** Waits until the fake CLI's log ends with `until` (or with "exit"), then prints it. */
async function printCliLog(name: string, until: string): Promise<void> {
  const file = cliLogPath(name);
  const deadline = Date.now() + CLI_LOG_WAIT_MS;
  let text = "";
  for (;;) {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    if (until === "none") break;
    const events = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as Json)["event"]);
    const last = events[events.length - 1];
    if (last === until || last === "exit") break;
    if (Date.now() > deadline) {
      log(`cli log: gave up waiting for ${until}`);
      break;
    }
    await sleep(POLL_MS);
  }
  for (const line of text.split("\n")) if (line.length > 0) log(`cli ${line}`);
}

interface Scenario {
  name: string;
  /** The last event the fake CLI records ("exit" is always accepted), or "none". */
  until: string;
  run: (query: QueryFunction, name: string) => Promise<void>;
}

const warnings: string[] = [];
process.on("warning", (warning: Error) => {
  warnings.push(`${warning.name}: ${warning.message}`);
});

function flushWarnings(): void {
  for (const warning of warnings.splice(0)) log(`warning ${warning}`);
}

const scenarios: Scenario[] = [
  {
    name: "paseo-turn",
    until: "exit",
    async run(query, name) {
      const stderrChunks: string[] = [];
      const input = new PromptQueue();
      const q = query({ prompt: input, options: paseoOptions(name, "paseo-turn", (data) => stderrChunks.push(data)) });
      let sawResult: () => void = () => {};
      const resultSeen = new Promise<void>((resolve) => {
        sawResult = resolve;
      });
      const pumped = pump(q, async (message) => {
        if (message.type === "result") sawResult();
        return false;
      });
      input.push("hello");
      await resultSeen;
      await call("supportedCommands", () => q.supportedCommands());
      await call("supportedModels", () => q.supportedModels());
      await call("supportedAgents", () => q.supportedAgents());
      await call("accountInfo", () => q.accountInfo());
      await call("setPermissionMode", () => q.setPermissionMode("plan"));
      await call("setModel bad", () => q.setModel("bad-model"));
      await call("setModel", () => q.setModel("opus"));
      await call("setModel undefined", () => q.setModel());
      await call("applyFlagSettings", () => q.applyFlagSettings({ fastMode: true }));
      await call("rewindFiles", () => q.rewindFiles("22222222-2222-4222-8222-222222222222", { dryRun: true }));
      await call("rewindFiles plain", () => q.rewindFiles("22222222-2222-4222-8222-222222222222"));
      await call("interrupt", () => q.interrupt());
      const cancel = (q as Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage;
      await call("cancelAsyncMessage", async () =>
        cancel ? await cancel.call(q, "33333333-3333-4333-8333-333333333333") : "missing"
      );
      await call("mcpServerStatus", () => q.mcpServerStatus());
      await call("stopTask", () => q.stopTask("task-1"));
      await call("backgroundTasks", () => q.backgroundTasks("toolu_1"));
      await call("getContextUsage", () => q.getContextUsage());
      input.end();
      await pumped;
      log(`stderr ${JSON.stringify(stderrChunks.join(""))}`);
      await call("setModel after end", () => q.setModel("opus"));
    },
  },
  {
    name: "discovery",
    until: "exit",
    async run(query, name) {
      const controller = new AbortController();
      let endInput: () => void = () => {};
      const ended = new Promise<void>((resolve) => {
        endInput = resolve;
      });
      const input: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<SDKUserMessage, undefined>> => {
              await ended;
              return { done: true, value: undefined };
            },
          };
        },
      };
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: fakeCli,
          cwd: outDir,
          env: fakeEnv(name, "discovery"),
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: ["user"],
          settings: { disableAllHooks: true },
          abortController: controller,
        },
      });
      await call("supportedModels", () => q.supportedModels());
      endInput();
      q.close();
      await call("next after close", () => q.next());
      await call("return", () => q.return());
    },
  },
  ...(["local", "custom"] as const).map(
    (spawner): Scenario => ({
      name: `exit-nonzero-${spawner}`,
      until: "exit",
      async run(query, name) {
        const stderrChunks: string[] = [];
        const input = new PromptQueue();
        const stderr = (data: string): void => {
          stderrChunks.push(data);
        };
        const q = query({
          prompt: input,
          options: {
            pathToClaudeCodeExecutable: fakeCli,
            env: fakeEnv(name, "exit-nonzero"),
            stderr,
            ...(spawner === "custom" ? { spawnClaudeCodeProcess: paseoSpawner(stderr) } : {}),
          },
        });
        input.push("go");
        await pump(q);
        log(`stderr ${JSON.stringify(stderrChunks.join(""))}`);
        await call("interrupt after exit", () => q.interrupt());
      },
    })
  ),
  {
    name: "error-result",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "error-result") },
      });
      input.push("go");
      await pump(q);
    },
  },
  {
    name: "abort-graceful",
    until: "exit",
    async run(query, name) {
      abortErrorsEquivalent = true;
      const controller = new AbortController();
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: fakeCli,
          env: fakeEnv(name, "abort-graceful"),
          abortController: controller,
          canUseTool,
        },
      });
      input.push("go");
      let pendingInterrupt: Promise<void> | undefined;
      await pump(q, async () => {
        pendingInterrupt = call("interrupt (unanswered)", () => q.interrupt());
        controller.abort();
        return false;
      });
      if (pendingInterrupt) await pendingInterrupt;
      await call("setModel after abort", () => q.setModel("opus"));
      abortErrorsEquivalent = false;
    },
  },
  {
    name: "abort-sigterm",
    until: "SIGTERM",
    async run(query, name) {
      const controller = new AbortController();
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: fakeCli,
          env: fakeEnv(name, "abort-sigterm"),
          abortController: controller,
          spawnClaudeCodeProcess: paseoSpawner(() => {}),
        },
      });
      input.push("go");
      const started = Date.now();
      await pump(q, async () => {
        controller.abort();
        return false;
      });
      log(`ended after grace period: ${Date.now() - started >= 1900}`);
    },
  },
  {
    name: "close-midstream",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "close-midstream") },
      });
      input.push("go");
      let pending: Promise<void> | undefined;
      await pump(q, async () => {
        pending = call("setModel (unanswered)", () => q.setModel("opus"));
        q.close();
        return false;
      });
      if (pending) await pending;
      await call("next after close", () => q.next());
    },
  },
  {
    name: "break-return",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "break-return") },
      });
      input.push("go");
      await pump(q, async () => true);
      await call("next after break", () => q.next());
      await call("interrupt after break", () => q.interrupt());
    },
  },
  {
    name: "cancel-request",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "cancel-request"), canUseTool },
      });
      input.push("go");
      await pump(q, async (message) => {
        if (message.type === "result") input.end();
        return false;
      });
    },
  },
  {
    name: "string-prompt",
    until: "exit",
    async run(query, name) {
      const q = query({
        prompt: "hi there",
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "string-prompt") },
      });
      await pump(q);
    },
  },
  {
    name: "pending-permission",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: fakeCli,
          env: fakeEnv(name, "pending-permission"),
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [hook] }] },
        },
      });
      await call("initializationResult", async () => Object.keys(await q.initializationResult()));
      await sleep(200);
      input.end();
      await pump(q);
    },
  },
  {
    name: "init-error",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "init-error") },
      });
      await call("supportedModels", () => q.supportedModels());
      await call("supportedCommands", () => q.supportedCommands());
      input.end();
      await pump(q);
    },
  },
  {
    name: "primitive-lines",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "primitive-lines") },
      });
      input.push("go");
      await pump(q, async (message) => {
        // A non-object line reaches the consumer as is; test the serialized form, not `.type`.
        if (JSON.stringify(message).startsWith('{"type":"result"')) input.end();
        return false;
      });
    },
  },
  {
    name: "null-line",
    until: "exit",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "null-line") },
      });
      input.push("go");
      await pump(q);
    },
  },
  {
    name: "signal-death",
    until: "none",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, env: fakeEnv(name, "signal-death") },
      });
      input.push("go");
      await pump(q);
    },
  },
  {
    name: "close-sigkill",
    until: "SIGTERM",
    async run(query, name) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: fakeCli,
          env: fakeEnv(name, "ignore-sigterm"),
          spawnClaudeCodeProcess: paseoSpawner(() => {}),
        },
      });
      await call("initializationResult", async () => Object.keys(await q.initializationResult()));
      const started = Date.now();
      await call("return", () => q.return());
      log(`return waited for exit at most ~2s: ${Date.now() - started < 4000}`);
      await sleep(7500);
      await call("next after kill", () => q.next());
    },
  },
  {
    name: "spawn-missing",
    until: "none",
    async run(query) {
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: path.join(outDir, "no-such-claude"),
          env: { PATH: process.env["PATH"] },
        },
      });
      input.push("go");
      await call("supportedModels", () => q.supportedModels());
      await pump(q);
    },
  },
  {
    name: "spawn-missing-script",
    until: "none",
    async run(query) {
      const q = query({
        prompt: "x",
        options: {
          pathToClaudeCodeExecutable: path.join(outDir, "no-such-cli.js"),
          executable: "node",
          env: { PATH: process.env["PATH"] },
        },
      });
      await pump(q);
    },
  },
  {
    name: "spawner-throws",
    until: "none",
    async run(query) {
      await call("query", async () => {
        query({
          prompt: "x",
          options: {
            pathToClaudeCodeExecutable: fakeCli,
            spawnClaudeCodeProcess: () => {
              throw new Error("spawner refused");
            },
          },
        });
        return "returned";
      });
    },
  },
  {
    name: "option-errors",
    until: "none",
    async run(query) {
      const base: Options = {
        pathToClaudeCodeExecutable: fakeCli,
        spawnClaudeCodeProcess: () => {
          throw new Error("must not spawn");
        },
      };
      await call("canUseTool+permissionPromptToolName", async () => {
        query({ prompt: "x", options: { ...base, canUseTool, permissionPromptToolName: "mcp__x__y" } });
      });
      await call("fallbackModel=model", async () => {
        query({ prompt: "x", options: { ...base, model: "opus", fallbackModel: "opus" } });
      });
      await call("supportedDialogKinds", async () => {
        query({ prompt: "x", options: { ...base, supportedDialogKinds: ["x"] } });
      });
      await call("skills bad", async () => {
        query({ prompt: "x", options: { ...base, skills: ["bad(name)"] } });
      });
      await call("sandbox with settings path", async () => {
        query({ prompt: "x", options: { ...base, settings: "/etc/settings.json", sandbox: { enabled: true } } });
      });
    },
  },
  ...argScenarios(),
  {
    name: "env-inherit",
    until: "exit",
    async run(query, name) {
      const saved = { ...process.env };
      process.env["FAKE_CLI_LOG"] = cliLogPath(name);
      process.env["FAKE_CLI_SCENARIO"] = "init-only";
      process.env["NODE_OPTIONS"] = "--inspect-brk";
      process.env["DEBUG"] = "1";
      process.env["CLAUDE_CODE_ENTRYPOINT"] = "custom-entry";
      delete process.env["CLAUDE_AGENT_SDK_VERSION"];
      const input = new PromptQueue();
      const q = query({
        prompt: input,
        options: { pathToClaudeCodeExecutable: fakeCli, permissionMode: "bypassPermissions", canUseTool },
      });
      log(`process CLAUDE_AGENT_SDK_VERSION ${String(process.env["CLAUDE_AGENT_SDK_VERSION"])}`);
      for (const key of ["FAKE_CLI_LOG", "FAKE_CLI_SCENARIO", "NODE_OPTIONS", "DEBUG", "CLAUDE_CODE_ENTRYPOINT"]) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await call("initializationResult", async () => Object.keys(await q.initializationResult()));
      input.end();
      await pump(q);
    },
  },
];

/** Scenarios that only check the argv, environment and initialize request. */
function argScenarios(): Scenario[] {
  const variants: Array<[string, Partial<Options>]> = [
    [
      "args-thinking-enabled",
      { thinking: { type: "enabled", budgetTokens: 4096, display: "omitted" }, maxTurns: 3, maxBudgetUsd: 1.5 },
    ],
    ["args-thinking-enabled-nobudget", { thinking: { type: "enabled" } }],
    ["args-thinking-disabled", { thinking: { type: "disabled" } }],
    ["args-max-thinking", { maxThinkingTokens: 2048 }],
    ["args-max-thinking-zero", { maxThinkingTokens: 0 }],
    [
      "args-misc",
      {
        agent: "helper",
        betas: ["context-1m-2025-08-07"],
        fallbackModel: "haiku",
        model: "sonnet",
        continue: true,
        tools: { type: "preset", preset: "claude_code" },
        skills: ["review", "plugin:skill"],
        allowedTools: ["Skill(review)"],
        plugins: [
          { type: "local", path: "/plugins/a" },
          { type: "local", path: "/plugins/b", skipMcpDiscovery: true },
        ],
        forkSession: true,
        resumeSessionAt: "44444444-4444-4444-8444-444444444444",
        sessionId: "55555555-5555-4555-8555-555555555555",
        includeHookEvents: true,
        debug: true,
        managedSettings: { model: "opus" },
        outputFormat: { type: "json_schema", schema: { type: "object" } },
        toolConfig: { askUserQuestion: { previewFormat: "html" } },
        systemPrompt: ["one", "two"],
        settings: '{"a":1}',
        sandbox: { enabled: true, failIfUnavailable: false },
        extraArgs: { settings: '{"ignored":true}', "x-flag": "v" },
        permissionPromptToolName: "mcp__perm__ask",
        title: "A title",
        promptSuggestions: true,
        agentProgressSummaries: false,
        toolAliases: { Read: "Look" },
        planModeInstructions: "plan well",
      },
    ],
    [
      "args-skills-all",
      { skills: "all", tools: ["Read", "Grep"], systemPrompt: "plain prompt", debugFile: "/tmp/never-written" },
    ],
    [
      "args-sandbox-extra-settings",
      {
        extraArgs: { settings: '{"keep":1}' },
        sandbox: { enabled: false },
        executableArgs: ["--ignored-for-binaries"],
      },
    ],
    ["args-defaults", {}],
  ];
  return variants.map(([name, extra]) => ({
    name,
    until: "exit",
    async run(query: QueryFunction) {
      const input = new PromptQueue();
      const options: Options = {
        pathToClaudeCodeExecutable: fakeCli,
        env: fakeEnv(name, "init-only"),
        spawnClaudeCodeProcess: paseoSpawner(() => {}),
        ...extra,
      };
      const q = query({ prompt: input, options });
      await call("initializationResult", async () => Object.keys(await q.initializationResult()));
      input.end();
      await pump(q);
    },
  }));
}

const scriptScenario: Scenario = {
  name: "script-path",
  until: "exit",
  async run(query, name) {
    const input = new PromptQueue();
    const q = query({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: fakeScript,
        executable: "node",
        executableArgs: ["--no-warnings"],
        env: fakeEnv(name, "init-only"),
        spawnClaudeCodeProcess: paseoSpawner(() => {}),
      },
    });
    await call("initializationResult", async () => Object.keys(await q.initializationResult()));
    input.end();
    await pump(q);
  },
};

export async function runQueryScenarios(
  query: QueryFunction,
  directory: string,
  only: string | undefined
): Promise<string[]> {
  outDir = directory;
  for (const scenario of [...scenarios, scriptScenario]) {
    if (only && scenario.name !== only) continue;
    rmSync(cliLogPath(scenario.name), { force: true });
    log(`== ${scenario.name}`);
    try {
      await withTimeout(scenario.run(query, scenario.name), SCENARIO_TIMEOUT_MS);
    } catch (error) {
      log(`scenario threw ${describeError(error)}`);
      if (trace && error instanceof Error) process.stderr.write(`${String(error.stack)}\n`);
    }
    await printCliLog(scenario.name, scenario.until);
    flushWarnings();
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// forkSession

const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_PLAIN = "aaaaaaaa-0000-4000-8000-000000000002";
const SESSION_COMMAND = "aaaaaaaa-0000-4000-8000-000000000003";
const SESSION_PROGRESS = "aaaaaaaa-0000-4000-8000-000000000004";
const SESSION_AITITLE = "aaaaaaaa-0000-4000-8000-000000000005";
const U = (n: number): string => `bbbbbbbb-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function fixtureLines(session: string): string[] {
  const at = (n: number): string => `2026-01-01T00:00:0${n}.000Z`;
  return [
    JSON.stringify({ type: "summary", summary: "old summary", leafUuid: U(9) }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Fix the bug in parser.ts\nplease" },
      uuid: U(1),
      timestamp: at(1),
      sessionId: session,
      cwd: "/work",
      gitBranch: "main",
      slug: "fix-bug",
      teamName: "team",
      agentName: "agent",
      sessionKind: "interactive",
      userType: "external",
    }),
    JSON.stringify({
      parentUuid: U(1),
      isSidechain: false,
      type: "progress",
      data: { step: 1 },
      uuid: U(2),
      timestamp: at(2),
      sessionId: session,
    }),
    JSON.stringify({
      parentUuid: U(2),
      logicalParentUuid: U(1),
      isSidechain: false,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "On it" }] },
      uuid: U(3),
      timestamp: at(3),
      sessionId: session,
      sourceToolAssistantUUID: U(1),
    }),
    JSON.stringify({
      parentUuid: U(3),
      isSidechain: true,
      type: "user",
      message: { role: "user", content: "sidechain" },
      uuid: U(4),
      timestamp: at(4),
      sessionId: session,
    }),
    JSON.stringify({
      parentUuid: U(3),
      isSidechain: false,
      type: "system",
      subtype: "model_refusal_fallback",
      content: "fallback",
      uuid: U(5),
      timestamp: at(5),
      sessionId: session,
    }),
    "{not json",
    "",
    "   ",
    JSON.stringify({
      parentUuid: U(5),
      logicalParentUuid: null,
      isSidechain: false,
      type: "attachment",
      attachment: { type: "file" },
      uuid: U(6),
      timestamp: at(6),
      sessionId: session,
    }),
    JSON.stringify({ type: "content-replacement", sessionId: session, replacements: [{ kind: "x", id: 1 }] }),
    JSON.stringify({ type: "content-replacement", sessionId: "other", replacements: [{ kind: "ignored" }] }),
    JSON.stringify({ type: "atis-latch", sessionId: session, atis: "abc!" }),
    JSON.stringify({ type: "relocated", sessionId: session, relocatedCwd: "/new/cwd" }),
    JSON.stringify({ type: "history-suppression", sessionId: session, cause: "x" }),
    JSON.stringify({ type: "custom-title", sessionId: session, customTitle: 'My \\"Title\\"' }),
    JSON.stringify({
      parentUuid: U(6),
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Second" }] },
      uuid: U(7),
      timestamp: at(7),
      sessionId: session,
    }),
  ];
}

function plainFixture(session: string): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      isMeta: true,
      message: { role: "user", content: "meta" },
      uuid: U(1),
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: session,
    }),
    JSON.stringify({
      parentUuid: U(1),
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "<command-name>/init</command-name>" },
      uuid: U(2),
      timestamp: "2026-01-01T00:00:02.000Z",
      sessionId: session,
    }),
    JSON.stringify({
      parentUuid: U(2),
      isSidechain: false,
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "<bash-input>  ls -la </bash-input>" }] },
      uuid: U(3),
      timestamp: "2026-01-01T00:00:03.000Z",
      sessionId: session,
    }),
  ];
}

function commandFixture(session: string): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "<command-name>/review</command-name>" },
      uuid: U(1),
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: session,
    }),
    JSON.stringify({
      parentUuid: U(1),
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "x".repeat(250) + " tail" },
      isCompactSummary: true,
      uuid: U(2),
      timestamp: "2026-01-01T00:00:02.000Z",
      sessionId: session,
    }),
  ];
}

function aiTitleFixture(session: string): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "y".repeat(230) },
      uuid: U(1),
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: session,
    }),
    JSON.stringify({ type: "ai-title", aiTitle: "Generated", sessionId: session }),
  ];
}

function progressOnlyFixture(session: string): string[] {
  return [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "progress",
      uuid: U(1),
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: session,
    }),
  ];
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_IN_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/** Generated UUIDs become G1, G2... in order of appearance; fixture UUIDs and dates stay. */
function normalizeFork(text: string, fixture: string): string {
  const names = new Map<string, string>();
  return text
    .replace(UUID_IN_TEXT, (id) => {
      if (fixture.includes(id)) return id;
      let name = names.get(id);
      if (!name) {
        name = `G${names.size + 1}`;
        names.set(id, name);
      }
      return name;
    })
    .replace(ISO_IN_TEXT, (date) => (fixture.includes(date) ? date : "<now>"));
}

/** JSON of an entry with its top-level keys sorted; undefined values are left out as JSON.stringify does. */
function sortedJson(entry: SessionStoreEntry): string {
  const fields = entry as Json;
  const parts: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value !== undefined) parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

function storeFor(folder: string, keys: string[]): SessionStore {
  const file = (sessionId: string): string => path.join(folder, `${sessionId}.jsonl`);
  return {
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      keys.push(`load ${key.projectKey} ${key.sessionId} ${String(key.subpath)}`);
      let text: string;
      try {
        text = await readFile(file(key.sessionId), "utf8");
      } catch {
        return null;
      }
      const entries: SessionStoreEntry[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            typeof (parsed as Json)["type"] === "string"
          )
            entries.push(parsed as SessionStoreEntry);
        } catch {
          continue;
        }
      }
      return entries;
    },
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      keys.push(`append ${key.projectKey} ${String(key.sessionId === "" ? "empty" : "id")} ${entries.length}`);
      // Keys sorted: scriptc writes a SessionStoreEntry with its declared fields (type, uuid,
      // timestamp) first, Node in insertion order (see README). The disk path compares raw bytes.
      await appendFile(file(key.sessionId), entries.map((entry) => `${sortedJson(entry)}\n`).join(""));
    },
  };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

export async function runForkScenarios(forkSession: ForkSessionFunction, directory: string): Promise<string[]> {
  outDir = directory;
  lines.splice(0);
  const configDir = path.join(directory, "claude-config");
  const projectRoot = path.join(directory, "project");
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
  const projectFolder = path.join(configDir, "projects", sanitize(realpathSync(projectRoot)));
  const otherFolder = path.join(configDir, "projects", "-some-other-project");
  mkdirSync(projectFolder, { recursive: true });
  mkdirSync(otherFolder, { recursive: true });
  const fixtures: Array<[string, string[]]> = [
    [SESSION, fixtureLines(SESSION)],
    [SESSION_PLAIN, plainFixture(SESSION_PLAIN)],
    [SESSION_COMMAND, commandFixture(SESSION_COMMAND)],
    [SESSION_PROGRESS, progressOnlyFixture(SESSION_PROGRESS)],
    [SESSION_AITITLE, aiTitleFixture(SESSION_AITITLE)],
  ];
  let allFixtures = "";
  for (const [id, fixture] of fixtures) {
    const text = `${fixture.join("\n")}\n`;
    allFixtures += text;
    writeFileSync(path.join(projectFolder, `${id}.jsonl`), text);
  }
  copyFileSync(path.join(projectFolder, `${SESSION_PLAIN}.jsonl`), path.join(otherFolder, `${SESSION_PLAIN}.jsonl`));
  rmSync(path.join(projectFolder, `${SESSION_PLAIN}.jsonl`));
  mkdirSync(path.join(projectFolder, SESSION_AITITLE), { recursive: true });
  writeFileSync(
    path.join(projectFolder, SESSION_AITITLE, "custom-title.json"),
    JSON.stringify({ customTitle: "  Sidecar\u0007 title\u200b  " })
  );
  const savedConfig = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = configDir;
  const keys: string[] = [];
  const store = storeFor(projectFolder, keys);
  const cases: Array<[string, string, ForkSessionOptions | undefined]> = [
    ["store full", SESSION, { sessionStore: store }],
    ["store up to assistant", SESSION, { sessionStore: store, upToMessageId: U(3) }],
    ["store up to progress", SESSION, { sessionStore: store, upToMessageId: U(2) }],
    ["store titled", SESSION, { sessionStore: store, title: "  Custom  ", dir: projectRoot }],
    ["store plain title", SESSION_COMMAND, { sessionStore: store }],
    ["store ai title", SESSION_AITITLE, { sessionStore: store }],
    ["store missing", "aaaaaaaa-0000-4000-8000-0000000000ee", { sessionStore: store }],
    ["store invalid id", "not-a-uuid", { sessionStore: store }],
    ["store invalid upTo", SESSION, { sessionStore: store, upToMessageId: "nope" }],
    ["store unknown upTo", SESSION, { sessionStore: store, upToMessageId: U(99) }],
    ["store sidechain upTo", SESSION, { sessionStore: store, upToMessageId: U(4) }],
    ["store progress only", SESSION_PROGRESS, { sessionStore: store }],
    ["disk with dir", SESSION, { dir: projectRoot }],
    ["disk sidecar title", SESSION_AITITLE, { dir: projectRoot }],
    ["disk scan", SESSION_PLAIN, undefined],
    ["disk command title", SESSION_COMMAND, {}],
    ["disk missing in dir", SESSION_PLAIN, { dir: projectRoot }],
    ["disk missing", "aaaaaaaa-0000-4000-8000-0000000000ee", {}],
    ["disk invalid id", "nope", undefined],
  ];
  try {
    for (const [label, sessionId, options] of cases) {
      log(`== fork ${label}`);
      const before = new Set([
        ...readdirSync(projectFolder),
        ...readdirSync(otherFolder).map((name) => `other/${name}`),
      ]);
      try {
        const result = await forkSession(sessionId, options);
        const created = [
          ...readdirSync(projectFolder),
          ...readdirSync(otherFolder).map((name) => `other/${name}`),
        ].filter((name) => !before.has(name));
        log(
          `created ${created.length} file(s); named after result: ${
            created.length === 1 && path.basename(created[0] ?? "") === `${result.sessionId}.jsonl`
          }`
        );
        for (const name of created) {
          const file = name.startsWith("other/")
            ? path.join(otherFolder, name.slice(6))
            : path.join(projectFolder, name);
          log(`mode ${(statSync(file).mode & 0o777).toString(8)}`);
          const text = readFileSync(file, "utf8");
          log(
            `sessionId fields match result: ${text
              .split("\n")
              .filter(Boolean)
              .every((line) => !line.includes('"sessionId"') || line.includes(result.sessionId))}`
          );
          for (const line of normalizeFork(text, allFixtures).split("\n")) if (line) log(`  ${line}`);
          rmSync(file);
        }
      } catch (error) {
        log(`threw ${describeError(error)}`);
      }
      for (const key of keys.splice(0))
        log(
          `store ${key
            .split(sanitize(realpathSync(process.cwd())))
            .join("<CWD-KEY>")
            .split(sanitize(realpathSync(projectRoot)))
            .join("<PROJECT-KEY>")}`
        );
    }
  } finally {
    if (savedConfig === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = savedConfig;
  }
  return lines;
}

export function writeLines(file: string, output: string[]): void {
  writeFileSync(file, "");
  for (const line of output) appendFileSync(file, `${line}\n`);
}
