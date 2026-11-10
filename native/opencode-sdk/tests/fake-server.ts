// A fake OpenCode server for the parity test. Records each request and answers with fixed
// responses that cover the client's result paths: JSON 200, JSON error, text error, 204,
// empty 200, text/html, and a server-sent events stream. GET /__last returns the last
// request recorded. Prints its port on stdout. usage: bun fake-server.ts
interface Recorded {
  method: string;
  path: string;
  query: Array<[string, string]>;
  contentType: string | null;
  directoryHeader: string | null;
  lastEventId: string | null;
  body: unknown;
}

let last: Recorded | null = null;

// Bodies are compared as JSON values: the stand-in writes body fields in its own order, the
// generated client in the caller's.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

// Shapes as the SDK declares them (types.gen.d.ts): a native build checks the cast.
const SESSION = {
  id: "s1",
  slug: "one",
  projectID: "p1",
  directory: "/tmp/work dir",
  title: "One",
  version: "1.14.46",
  time: { created: 1, updated: 2 },
};
const USER_MESSAGE = {
  info: {
    id: "m1",
    sessionID: "s1",
    role: "user",
    time: { created: 3 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  },
  parts: [],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__last") return json(last);
    const text = await request.text();
    let body: unknown = null;
    if (text) {
      try {
        body = sortKeys(JSON.parse(text));
      } catch {
        body = text;
      }
    }
    last = {
      method: request.method,
      path: url.pathname,
      query: [...url.searchParams.entries()],
      contentType: request.headers.get("content-type"),
      directoryHeader: request.headers.get("x-opencode-directory"),
      lastEventId: request.headers.get("last-event-id"),
      body,
    };
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /session/s1":
        return json(SESSION);
      case "GET /session/missing":
        return json({ name: "NotFoundError", data: { message: "Session not found: missing" } }, 404);
      case "POST /session/s1/abort":
        return json(true);
      case "POST /session":
        return json({ ...SESSION, id: "s2" });
      case "PATCH /session/s1":
        return json(SESSION);
      case "DELETE /session/s1":
        return json(true);
      case "GET /session/status":
        return json({ s1: { type: "idle" } });
      case "POST /session/s1/prompt_async":
        return new Response(null, { status: 204 });
      case "GET /session/s1/message":
        return json([USER_MESSAGE]);
      case "GET /session/s1/children":
        return json([]);
      case "POST /session/s1/revert":
        return json(SESSION);
      case "GET /provider":
        return new Response("provider list failed", { status: 500 });
      case "POST /session/s1/summarize":
        return json(true);
      case "POST /session/s1/command":
        return json({
          info: {
            id: "m2",
            sessionID: "s1",
            role: "assistant",
            time: { created: 4 },
            parentID: "m1",
            modelID: "m",
            providerID: "p",
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp/work dir", root: "/tmp/work dir" },
            cost: 0,
            tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        });
      case "GET /permission":
        return json([]);
      case "GET /question":
        return json([]);
      case "POST /permission/p1/reply":
        return json(true);
      case "GET /agent":
        return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
      case "POST /question/q1/reply":
        return json(true);
      case "POST /question/q1/reject":
        return json(true);
      case "GET /pty":
        return json([]);
      case "POST /mcp":
        return json({ ok: { status: "connected" } });
      case "GET /command":
        return json([{ name: "init", description: "Init", template: "init", hints: [] }]);
      case "GET /experimental/session":
        return json([{ ...SESSION, project: null }]);
      case "GET /global/event":
        return new Response(
          'id: 7\ndata: {"directory":"/w","payload":{"id":"e1","type":"server.connected","properties":{}}}\n\n' +
            'retry: 100\ndata: {"directory":"/w","payload":{"id":"e3","type":"session.idle","properties":{"sessionID":"s2"}}}\n\n' +
            'data: {"directory":"/w",\ndata: "payload":{"id":"e2","type":"session.idle","properties":{"sessionID":"s1"}}}\r\n\r\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      default:
        return json({ unexpected: route }, 418);
    }
  },
});

console.log(server.port);
