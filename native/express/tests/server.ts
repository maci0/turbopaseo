// Probe server on ../express.ts. Runs under Node (tsx) and as a native
// scriptc binary. tests/server-express.ts mounts the same routes on real
// express; keep the two files in step. Handler bodies follow Paseo's
// bootstrap.ts, auth.ts, web-ui.ts and service-proxy.ts.
import { createReadStream, readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "../express.js";

const AUTH_TOKEN = "Bearer secret";
const FIXED_TIMESTAMP = "2020-01-01T00:00:00.000Z";
const ALLOWED_ORIGIN = "http://allowed.example";
const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const BEARER_FREE_PATHS = new Set(["/api/health", "/api/files/download", "/mcp/agents"]);
/** `trust proxy` entries both implementations must reject or accept alike. */
const INVALID_TRUST_ENTRIES = [
  "not-an-ip",
  "1.2.3",
  "10.0.0.0/0",
  "10.0.0.0/33",
  "fe80::/129",
  "10.0.0.0/255.0.255.0",
  "10.0.0.0/x",
  "loopback",
  "::ffff:10.0.0.1",
  "toString",
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const staticDir = requiredEnv("PROBE_STATIC_DIR");
const uiDir = requiredEnv("PROBE_UI_DIR");
const downloadFile = requiredEnv("PROBE_DOWNLOAD_FILE");

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function stripHopByHop(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding") {
      continue;
    }
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

// Upstream for the service-proxy route: echoes what it received.
function handleUpstream(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const text = JSON.stringify({
      method: req.method,
      url: req.url,
      forwardedProto: req.headers["x-forwarded-proto"],
      forwardedHost: req.headers["x-forwarded-host"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
    res.end(text);
  });
}

function buildApp(upstreamPort: number): express.Application {
  const app = express();
  app.set("trust proxy", ["loopback"]);

  // service-proxy.ts createScriptProxyMiddleware + proxyHttpRequest
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (host === "missing.svc.localhost") {
      res.status(404).send("404 Not Found");
      return;
    }
    if (host !== "proxy.svc.localhost") {
      next();
      return;
    }
    const headers = stripHopByHop(req.headers);
    headers["x-forwarded-proto"] = req.protocol;
    headers["x-forwarded-host"] = host;
    const proxyReq = httpRequest(
      { host: "127.0.0.1", port: upstreamPort, path: req.originalUrl, method: req.method, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, stripHopByHop(proxyRes.headers));
        proxyRes.pipe(res.raw);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("502 Bad Gateway");
      }
    });
    req.pipe(proxyReq, { end: true });
  });

  // bootstrap.ts host allowlist
  app.use((req, res, next) => {
    if (req.headers.host === "evil.example") {
      res.status(403).json({ error: "Invalid Host header" });
      return;
    }
    next();
  });

  // bootstrap.ts CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === ALLOWED_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // bootstrap.ts createTerminalActivityRouteHandler
  app.post("/api/terminal-activity", express.json(), async (req, res) => {
    if (!LOOPBACK_REMOTE_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }
    await Promise.resolve();
    res.status(204).end();
  });

  // web-ui.ts createWebUiMiddleware, under /ui so it does not shadow the API
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path !== "/ui/" && req.path !== "/ui/app.js") {
      next();
      return;
    }
    const isIndexHtml = req.path === "/ui/";
    const file = path.join(uiDir, isIndexHtml ? "index.html" : "app.js");
    res.setHeader(
      "Content-Type",
      isIndexHtml ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8",
    );
    res.setHeader("Cache-Control", isIndexHtml ? "no-store" : "no-cache");
    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }
    if (isIndexHtml) {
      const html = readFileSync(file, "utf-8");
      const hint = JSON.stringify({ listen: req.headers.host ?? "", useTls: req.protocol === "https" });
      res.status(200).send(html.replace("</head>", `<script>${hint}</script></head>`));
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  });

  // auth.ts createRequireBearerMiddleware
  app.use((req, res, next) => {
    if (req.method === "OPTIONS" || BEARER_FREE_PATHS.has(req.path) || req.path.toLowerCase().startsWith("/public")) {
      next();
      return;
    }
    void (async () => {
      try {
        if (req.header("x-auth-throw") === "1") {
          throw new Error("auth backend failed: secret detail");
        }
        await Promise.resolve();
        if (req.header("authorization") !== AUTH_TOKEN) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  });

  app.use(express.json());
  app.use("/public", express.static(staticDir));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: FIXED_TIMESTAMP });
  });

  app.get("/api/echo", (req, res) => {
    res.json({
      query: req.query,
      path: req.path,
      originalUrl: req.originalUrl,
      protocol: req.protocol,
      header: req.header("X-Test") ?? null,
      referrer: req.header("referrer") ?? null,
    });
  });

  app.post("/api/echo-body", (req, res) => {
    res.json({ body: req.body });
  });

  app.get("/api/throw", () => {
    throw new Error("boom: secret detail");
  });

  app.get("/api/reject", async () => {
    await Promise.resolve();
    throw new Error("async boom: secret detail");
  });

  app.get("/api/status-then-throw", (_req, res) => {
    res.status(403);
    throw new Error("forbidden boom");
  });

  app.get("/api/next-error", (_req, _res, next) => {
    next(new Error("passed to next"));
  });

  app.get("/api/after-headers", (_req, res, next) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.raw.write("partial");
    next(new Error("late failure"));
  });

  app.get("/api/header-inject", (_req, res) => {
    let code = "none";
    try {
      res.setHeader("X-Bad", "a\r\nInjected: yes");
    } catch (err) {
      code = String((err as NodeJS.ErrnoException).code);
    }
    let nameCode = "none";
    try {
      res.setHeader("X-Bad\r\nInjected", "yes");
    } catch (err) {
      nameCode = String((err as NodeJS.ErrnoException).code);
    }
    res.json({ code, nameCode });
  });

  // bootstrap.ts handleFileDownload
  app.get("/api/files/download", (req, res) => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;
    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }
    if (token !== "valid") {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="download.bin"');
    const stream = createReadStream(downloadFile);
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  });

  // bootstrap.ts runAgentMcpRequest, without the MCP transport
  const handleMcp: express.RequestHandler = (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
      return;
    }
    const callerRaw = req.query.callerAgentId;
    let caller: string | undefined;
    if (typeof callerRaw === "string") {
      caller = callerRaw;
    } else if (Array.isArray(callerRaw) && typeof callerRaw[0] === "string") {
      caller = callerRaw[0];
    }
    res.json({ caller: caller ?? null, session: req.header("mcp-session-id") ?? null, body: req.body });
  };
  app.post("/mcp/agents", handleMcp);
  app.get("/mcp/agents", handleMcp);
  app.delete("/mcp/agents", handleMcp);

  return app;
}

/** Trusts 127.0.0.2 by netmask and 127.0.0.3 as an IPv4-mapped IPv6 subnet, not 127.0.0.1. */
function buildUntrustedApp(): express.Application {
  const app = express();
  app.set("trust proxy", [
    "10.0.0.0/8",
    "127.0.0.2/255.255.255.255",
    "::ffff:127.0.0.3/128",
    "fd00::/8",
  ]);
  app.get("/api/echo", (req, res) => {
    res.json({ protocol: req.protocol });
  });
  return app;
}

function buildTrustAllApp(): express.Application {
  const app = express();
  app.set("trust proxy", true);
  app.get("/api/echo", (req, res) => {
    res.json({ protocol: req.protocol });
  });
  return app;
}

async function main(): Promise<void> {
  process.on("unhandledRejection", () => {
    // express 4 leaves async handler rejections unhandled; keep the probe alive.
  });
  const upstream = createServer(handleUpstream);
  const upstreamPort = await listen(upstream);
  const app = buildApp(upstreamPort);
  const untrusted = buildUntrustedApp();
  const trustAll = buildTrustAllApp();
  const port = await listen(createServer(app));
  const untrustedPort = await listen(createServer(untrusted));
  const trustAllPort = await listen(createServer(trustAll));
  const invalidTrust: string[] = [];
  for (const entry of INVALID_TRUST_ENTRIES) {
    try {
      express().set("trust proxy", [entry]);
      invalidTrust.push(`${entry}: accepted`);
    } catch (err) {
      invalidTrust.push(err instanceof Error ? err.message : "error");
    }
  }
  console.log(JSON.stringify({ port, untrustedPort, trustAllPort, invalidTrust: invalidTrust.join("; ") }));
}

void main();
