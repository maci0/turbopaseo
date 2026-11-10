#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks the SDK's stream-json stdio protocol and
// never calls an API. It records its argv, cwd, environment, every stdin line and what it
// sees (stdin end, SIGTERM) as JSON lines in $FAKE_CLI_LOG, answers the SDK's control
// requests, and plays the scenario named by $FAKE_CLI_SCENARIO. Runs under Node.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Json = { [key: string]: unknown };

const RECORDED_ENV = [
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  "NODE_OPTIONS",
  "DEBUG",
  "DEBUG_CLAUDE_AGENT_SDK",
  "FAKE_MARK",
];

/** How long the fake waits for a reply that must not come. */
const SILENCE_MS = 300;
/** Pause between output the consumer reads and a control request. */
const SETTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** No fake outlives this, whatever the scenario or the SDK under test does. */
const MAX_LIFETIME_MS = 30_000;
setTimeout(() => {
  record({ event: "lifetime-exceeded" });
  process.exit(99);
}, MAX_LIFETIME_MS).unref();

const logPath = process.env["FAKE_CLI_LOG"] ?? "";
const scenario = process.env["FAKE_CLI_SCENARIO"] ?? "";

function record(entry: Json): void {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

const envValues: Json = {};
for (const key of RECORDED_ENV) if (key in process.env) envValues[key] = process.env[key];
record({
  event: "start",
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: envValues,
  envKeys: Object.keys(process.env).sort(),
});

const sdkIds = new Map<string, string>();
function sdkId(id: string): string {
  let name = sdkIds.get(id);
  if (!name) {
    name = `sdk#${sdkIds.size + 1}`;
    sdkIds.set(id, name);
  }
  return name;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendRaw(text: string): void {
  process.stdout.write(text);
}

const waiters: Array<{ match: (message: Json) => boolean; resolve: (message: Json) => void }> = [];
let stdinEnded = false;
const endWaiters: Array<() => void> = [];

function waitFor(match: (message: Json) => boolean): Promise<Json> {
  return new Promise((resolve) => waiters.push({ match, resolve }));
}

function waitForStdinEnd(): Promise<void> {
  if (stdinEnded) return Promise.resolve();
  return new Promise((resolve) => endWaiters.push(resolve));
}

let cliRequests = 0;
function request(body: Json): Promise<Json> {
  const id = `cli-${++cliRequests}`;
  send({ type: "control_request", request_id: id, request: body });
  return waitFor(
    (message) => message["type"] === "control_response" && (message["response"] as Json)["request_id"] === id
  );
}

function userMessage(): Promise<Json> {
  return waitFor((message) => message["type"] === "user");
}

const INIT_RESPONSE: Json = {
  commands: [{ name: "review", description: "Review code", argumentHint: "" }],
  agents: [{ name: "helper", description: "Helps" }],
  output_style: "default",
  available_output_styles: ["default"],
  models: [
    { value: "sonnet", displayName: "Sonnet", description: "Balanced" },
    { value: "opus", displayName: "Opus", description: "Strongest" },
  ],
  account: { email: "fake@example.invalid", subscriptionType: "fake" },
};

/** Answers for the SDK's control requests; a scenario can override or withhold one. */
const answers: Record<string, (body: Json) => { response?: Json; error?: string; extra?: Json } | null> = {
  initialize: () => ({ response: INIT_RESPONSE }),
  interrupt: () => ({ response: { still_queued: ["q1", 5], cancelled: ["c1"] } }),
  set_permission_mode: () => ({ response: {} }),
  set_model: (body) =>
    body["model"] === "bad-model" ? { error: "model bad-model is not available" } : { response: {} },
  apply_flag_settings: () => ({ response: {} }),
  rewind_files: (body) => ({ response: { canRewind: true, filesChanged: ["a.txt"], dryRun: body["dry_run"] ?? null } }),
  cancel_async_message: () => ({ response: { cancelled: true } }),
  mcp_status: () => ({ response: { mcpServers: [{ name: "fs", status: "connected" }] } }),
  stop_task: () => ({ response: {} }),
  background_tasks: () => ({ response: {} }),
};

function answer(message: Json): void {
  const requestId = message["request_id"] as string;
  const body = message["request"] as Json;
  const handler = answers[body["subtype"] as string];
  const reply = handler ? handler(body) : { error: `fake: no answer for ${String(body["subtype"])}` };
  if (reply === null) return;
  const response =
    reply.error !== undefined
      ? { subtype: "error", request_id: requestId, error: reply.error }
      : { subtype: "success", request_id: requestId, response: reply.response, ...reply.extra };
  send({ type: "control_response", response });
}

function normalizeIds(message: Json): Json {
  const copy: Json = JSON.parse(JSON.stringify(message)) as Json;
  if (typeof copy["request_id"] === "string" && copy["type"] === "control_request")
    copy["request_id"] = sdkId(copy["request_id"]);
  const response = copy["response"];
  if (copy["type"] === "control_response" && typeof response === "object" && response !== null) {
    const body = response as Json;
    const id = body["request_id"];
    if (typeof id === "string" && !id.startsWith("cli-")) body["request_id"] = sdkId(id);
  }
  return copy;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    record({ event: "stdin-raw", line });
    return;
  }
  record({ event: "stdin", message: normalizeIds(message) });
  if (message["type"] === "control_request") answer(message);
  const index = waiters.findIndex((waiter) => waiter.match(message));
  if (index !== -1) {
    const [waiter] = waiters.splice(index, 1);
    waiter?.resolve(message);
  }
});
lines.on("close", () => {
  stdinEnded = true;
  record({ event: "stdin-end" });
  for (const resolve of endWaiters.splice(0)) resolve();
});

let ignoreSigterm = false;
process.on("SIGTERM", () => {
  record({ event: "SIGTERM" });
  if (ignoreSigterm) return;
  process.removeAllListeners("SIGTERM");
  process.kill(process.pid, "SIGTERM");
});

function exit(code: number): void {
  record({ event: "exit", code });
  process.exit(code);
}

function systemInit(): Json {
  return {
    type: "system",
    subtype: "init",
    session_id: "s-1",
    uuid: "00000000-0000-4000-8000-000000000001",
    model: "sonnet",
  };
}

function result(extra: Json = {}): Json {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "s-1",
    uuid: "00000000-0000-4000-8000-0000000000ff",
    ...extra,
  };
}

const scenarios: Record<string, () => Promise<void>> = {
  async "paseo-turn"() {
    await userMessage();
    send({ type: "keep_alive" });
    send(systemInit());
    send({
      type: "system",
      subtype: "commands_changed",
      commands: [{ name: "fresh", description: "New", argumentHint: "" }],
    });
    send({
      type: "stream_event",
      event: { type: "message_start" },
      session_id: "s-1",
      parent_tool_use_id: null,
      uuid: "u-se",
    });
    send({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      session_id: "s-1",
      parent_tool_use_id: null,
      uuid: "u-a",
    });
    // When a message and a control request arrive in one read, whether the consumer sees the
    // message before the callback runs depends on microtask order, which differs between Node
    // and scriptc. A pause makes the order deterministic.
    await sleep(SETTLE_MS);
    record({
      event: "reply",
      reply: normalizeIds(
        await request({
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
          tool_use_id: "toolu_1",
          permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
          blocked_path: "/blocked",
          decision_reason: "because",
          title: "Run ls",
          display_name: "Bash",
          description: "lists",
          agent_id: "agent-1",
          matched_ask_rule: { source: "userSettings", tool_name: "Bash", rule_content: "ls" },
        })
      ),
    });
    record({
      event: "reply",
      reply: normalizeIds(
        await request({ subtype: "can_use_tool", tool_name: "Explode", input: {}, tool_use_id: "toolu_2" })
      ),
    });
    record({
      event: "reply",
      reply: normalizeIds(
        await request({
          subtype: "hook_callback",
          callback_id: "hook_0",
          input: { hook_event_name: "PreToolUse", tool_name: "Bash" },
          tool_use_id: "toolu_1",
        })
      ),
    });
    record({
      event: "reply",
      reply: normalizeIds(
        await request({ subtype: "hook_callback", callback_id: "hook_2", input: { hook_event_name: "SubagentStop" } })
      ),
    });
    record({
      event: "reply",
      reply: normalizeIds(await request({ subtype: "hook_callback", callback_id: "hook_99", input: {} })),
    });
    record({ event: "reply", reply: normalizeIds(await request({ subtype: "bogus" })) });
    record({
      event: "reply",
      reply: normalizeIds(
        await request({
          subtype: "mcp_message",
          server_name: "x",
          message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        })
      ),
    });
    record({
      event: "reply",
      reply: normalizeIds(await request({ subtype: "elicitation", mcp_server_name: "x", message: "?" })),
    });
    record({ event: "reply", reply: normalizeIds(await request({ subtype: "oauth_token_refresh" })) });
    sendRaw("this is not json\n\n   \n");
    sendRaw(`${JSON.stringify({ type: "system", subtype: "status", status: "crlf", session_id: "s-1" })}\r\n`);
    sendRaw(`${JSON.stringify({ type: "system", subtype: "status", status: "cr", session_id: "s-1" })}\r`);
    sendRaw(
      `\n${JSON.stringify({ type: "system", subtype: "status", status: "split", session_id: "s-1" }).slice(0, 20)}`
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    sendRaw(`${JSON.stringify({ type: "system", subtype: "status", status: "split", session_id: "s-1" }).slice(20)}\n`);
    send({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s-1" });
    send(result());
    await waitForStdinEnd();
    send({ type: "system", subtype: "status", status: "after-stdin-end", session_id: "s-1" });
    exit(0);
  },

  async discovery() {
    await waitForStdinEnd();
    exit(0);
  },

  async "exit-nonzero"() {
    await userMessage();
    send(systemInit());
    process.stderr.write("boom on stderr\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    exit(3);
  },

  async "error-result"() {
    await userMessage();
    send(result({ subtype: "error_during_execution", is_error: true, errors: [" bad thing ", "", "worse"] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    exit(1);
  },

  async "abort-graceful"() {
    answers["interrupt"] = () => null;
    await userMessage();
    send(systemInit());
    await waitForStdinEnd();
    exit(0);
  },

  async "abort-sigterm"() {
    await userMessage();
    send(systemInit());
    await waitForStdinEnd();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  },

  async "close-midstream"() {
    answers["set_model"] = () => null;
    await userMessage();
    send(systemInit());
    await waitForStdinEnd();
    exit(0);
  },

  async "break-return"() {
    await userMessage();
    send(systemInit());
    send({
      type: "assistant",
      message: { role: "assistant", content: [] },
      session_id: "s-1",
      parent_tool_use_id: null,
      uuid: "u-2",
    });
    await waitForStdinEnd();
    exit(0);
  },

  async "cancel-request"() {
    await userMessage();
    const reply = request({ subtype: "can_use_tool", tool_name: "Slow", input: {}, tool_use_id: "toolu_9" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    send({ type: "control_cancel_request", request_id: "cli-1" });
    record({ event: "reply", reply: normalizeIds(await reply) });
    send(result());
    await waitForStdinEnd();
    exit(0);
  },

  async "string-prompt"() {
    await userMessage();
    send(systemInit());
    send(result());
    await waitForStdinEnd();
    exit(0);
  },

  async "pending-permission"() {
    answers["initialize"] = () => ({
      response: INIT_RESPONSE,
      extra: {
        pending_permission_requests: [
          {
            type: "control_request",
            request_id: "pending-1",
            request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: "/x" }, tool_use_id: "toolu_p" },
          },
          {
            type: "control_request",
            request_id: "pending-2",
            request: { subtype: "hook_callback", callback_id: "hook_0", input: {} },
          },
        ],
      },
    });
    const reply = waitFor(
      (message) => message["type"] === "control_response" && (message["response"] as Json)["request_id"] === "pending-1"
    );
    record({ event: "reply", reply: await Promise.race([reply, sleep(SILENCE_MS * 3).then(() => "no reply")]) });
    await waitForStdinEnd();
    exit(0);
  },

  async "init-only"() {
    await waitForStdinEnd();
    exit(0);
  },

  async "init-error"() {
    answers["initialize"] = () => ({ error: "not logged in" });
    await waitForStdinEnd();
    exit(0);
  },

  async "primitive-lines"() {
    await userMessage();
    sendRaw('5\n"text"\n[1,2]\n');
    send(result());
    await waitForStdinEnd();
    exit(0);
  },

  async "null-line"() {
    await userMessage();
    sendRaw("null\n");
    await waitForStdinEnd();
    exit(0);
  },

  async "signal-death"() {
    await userMessage();
    send(systemInit());
    process.removeAllListeners("SIGTERM");
    process.kill(process.pid, "SIGTERM");
  },

  async "ignore-sigterm"() {
    ignoreSigterm = true;
    await waitForStdinEnd();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  },
};

const play = scenarios[scenario];
if (!play) {
  record({ event: "unknown-scenario", scenario });
  exit(64);
} else {
  play().catch((error: unknown) => {
    record({ event: "scenario-error", error: String(error) });
    exit(70);
  });
}
