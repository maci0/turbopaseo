// Parity scenario: the calls Paseo makes, with its argument shapes, against fake-server.ts.
// Run with the real SDK under Bun (tsconfig.real.json) and natively with the stand-in
// (tsconfig.json); test.sh compares the two outputs. usage: scenario <port>
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const port = process.argv[2];
const base = `http://127.0.0.1:${port}`;
const directory = "/tmp/work dir";
const client = createOpencodeClient({ baseUrl: base, directory });

interface Outcome {
  data?: unknown;
  error?: unknown;
  response?: Response | undefined;
  request: Request;
}

function describeError(error: unknown): unknown {
  return error instanceof Error ? { errorClass: error.name } : error;
}

async function lastRequest(): Promise<unknown> {
  const response = await fetch(`${base}/__last`);
  return (await response.json()) as unknown;
}

async function report(name: string, call: () => Promise<Outcome>): Promise<void> {
  try {
    const result = await call();
    console.log(
      JSON.stringify({
        name,
        data: result.data,
        error: describeError(result.error),
        status: result.response?.status,
        url: result.request.url,
        method: result.request.method,
        server: await lastRequest(),
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ name, threw: error instanceof Error ? error.message : String(error) }));
  }
}

await report("session.get", () => client.session.get({ sessionID: "s1", directory }));
await report("session.get 404", () => client.session.get({ sessionID: "missing", directory }));
await report("session.abort", () => client.session.abort({ sessionID: "s1", directory }));
await report("session.create", () => client.session.create({ directory }));
await report("session.create permission", () =>
  client.session.create({ directory, permission: [{ permission: "bash", pattern: "*", action: "ask" }] }),
);
await report("session.update", () =>
  client.session.update({ sessionID: "s1", directory, time: { archived: 5 } }),
);
await report("session.delete", () => client.session.delete({ sessionID: "s1", directory }));
await report("session.status", () =>
  client.session.status({ directory }, { signal: AbortSignal.timeout(10_000) }),
);
await report("session.promptAsync", () =>
  client.session.promptAsync({
    sessionID: "s1",
    directory,
    messageID: "msg_1",
    parts: [{ type: "text", text: "hello & bye" }],
    system: "be brief",
    model: { providerID: "p", modelID: "m" },
  }),
);
await report("session.messages", () => client.session.messages({ sessionID: "s1", directory }));
await report("session.children", () => client.session.children({ sessionID: "s1", directory }));
await report("session.revert", () =>
  client.session.revert({ sessionID: "s1", directory, messageID: "msg_1" }),
);
await report("session.summarize", () =>
  client.session.summarize({ sessionID: "s1", directory, providerID: "p", modelID: "m" }),
);
await report("session.command", () =>
  client.session.command({ sessionID: "s1", directory, command: "init", arguments: "", messageID: "msg_2" }),
);
await report("permission.list", () => client.permission.list({ directory }, { signal: AbortSignal.timeout(10_000) }));
await report("question.list", () => client.question.list({ directory }, { signal: AbortSignal.timeout(10_000) }));
await report("provider.list 500", () => client.provider.list({ directory }));
await report("permission.reply", () =>
  client.permission.reply({ requestID: "p1", directory, reply: "once", message: undefined }),
);
await report("app.agents html", () => client.app.agents({ directory }));
await report("question.reply", () =>
  client.question.reply({ requestID: "q1", directory, answers: [["yes"]] }),
);
await report("question.reject", () => client.question.reject({ requestID: "q1", directory }));
await report("pty.list", () => client.pty.list({ directory }));
await report("mcp.add", () =>
  client.mcp.add({ directory, name: "srv", config: { type: "remote", url: "http://x" } }),
);
await report("command.list", () => client.command.list({ directory }));
await report("experimental.session.list", () =>
  client.experimental.session.list({ archived: true, roots: true, limit: 25 }),
);
await report("experimental.session.list cwd", () =>
  client.experimental.session.list({ archived: true, roots: true, limit: 25, directory }),
);

const unreachable = createOpencodeClient({ baseUrl: "http://127.0.0.1:9", directory });
await report("fetch failure", () => unreachable.session.get({ sessionID: "s1", directory }));

const errors: string[] = [];
const events: unknown[] = [];
const result = await client.global.event({
  signal: AbortSignal.timeout(10_000),
  sseMaxRetryAttempts: 0,
  onSseError: (error) => {
    errors.push(error instanceof Error ? error.name : String(error));
  },
});
for await (const event of result.stream) events.push(event);
console.log(JSON.stringify({ name: "global.event", events, errors, server: await lastRequest() }));
