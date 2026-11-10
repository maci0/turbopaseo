// Sends the same requests to real express (Node), to ../express.ts under Node,
// and to ../express.ts compiled by scriptc, then compares status, headers and
// body. A difference from express fails unless README.md lists it in the
// intentional-differences table; any difference between the module's Node and
// native runs fails. Run by test.sh, which sets the environment below.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { gzipSync } from "node:zlib";

const REQUEST_TIMEOUT_MS = 3000;
const STARTUP_TIMEOUT_MS = 15000;
const MAX_TEXT_BODY_BYTES = 4096;
const JSON_LIMIT_BYTES = 100 * 1024;
const AUTH = { authorization: "Bearer secret" };
/** The fixture file outside the static root; no module response may contain it. */
const SECRET_MARKER = "top secret";
const HUGE_BODY_BYTES = 64 * 1024 * 1024;
const HUGE_BODY_CHUNK_BYTES = 64 * 1024;
/** Draining must not buffer the body; allow for allocator and V8 noise. */
const MAX_DRAIN_GROWTH_BYTES = 16 * 1024 * 1024;
/** Hop-by-hop and clock headers that say nothing about the module. */
const IGNORED_HEADERS = new Set(["date", "connection", "keep-alive"]);

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

interface Startup {
  port: number;
  untrustedPort: number;
  trustAllPort: number;
  invalidTrust: string;
}

interface Target {
  name: string;
  child: ChildProcess;
  startup: Startup;
}

type Port = "main" | "untrusted" | "trustAll";

interface Case {
  name: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the body in these pieces with chunked transfer encoding. */
  chunks?: string[];
  port?: Port;
  /** Source address of the client socket (any 127.0.0.0/8 address works on Linux). */
  localAddress?: string;
  /** Copy this response header of an earlier case (from express) into a request header. */
  reuse?: { case: string; header: string; as: string };
}

interface Result {
  status: string;
  headers: Record<string, string>;
  body: string;
}

function startTarget(name: string, command: string, args: string[], extraEnv: Record<string, string>): Promise<Target> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buffered = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} did not report its ports within ${STARTUP_TIMEOUT_MS} ms`));
    }, STARTUP_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited early with ${String(code)}`));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        return;
      }
      clearTimeout(timer);
      child.removeAllListeners("exit");
      resolve({ name, child, startup: JSON.parse(buffered.slice(0, newline)) as Startup });
    });
  });
}

function portOf(target: Target, port: Port | undefined): number {
  if (port === "untrusted") {
    return target.startup.untrustedPort;
  }
  if (port === "trustAll") {
    return target.startup.trustAllPort;
  }
  return target.startup.port;
}

function describeBody(body: Buffer): string {
  const text = body.toString("utf8");
  if (body.length <= MAX_TEXT_BODY_BYTES && Buffer.from(text, "utf8").equals(body)) {
    return text;
  }
  return `<${body.length} bytes sha256:${createHash("sha256").update(body).digest("hex")}>`;
}

function send(target: Target, item: Case, headers: Record<string, string>): Promise<Result> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let status = "error";
    let responseHeaders: Record<string, string> = {};
    const finish = (suffix: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status: status + suffix, headers: responseHeaders, body: describeBody(Buffer.concat(chunks)) });
    };
    const req = request(
      {
        host: "127.0.0.1",
        port: portOf(target, item.port),
        method: item.method,
        path: item.path,
        headers,
        agent: false,
        localAddress: item.localAddress,
      },
      (res) => {
        status = String(res.statusCode);
        responseHeaders = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined && !IGNORED_HEADERS.has(name)) {
            responseHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
          }
        }
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => finish(""));
        res.on("aborted", () => finish(" aborted"));
        res.on("error", () => finish(" aborted"));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      if (!settled) {
        settled = true;
        resolve({ status: "timeout", headers: {}, body: "" });
      }
    }, REQUEST_TIMEOUT_MS);
    req.on("error", () => finish(status === "error" ? "" : " aborted"));
    if (item.chunks !== undefined) {
      for (const piece of item.chunks) {
        req.write(piece);
      }
      req.end();
    } else if (item.body !== undefined) {
      req.end(item.body);
    } else {
      req.end();
    }
  });
}

function jsonOfSize(bytes: number): string {
  const prefix = '{"pad":"';
  const suffix = '"}';
  return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
}

const BIG_JSON = jsonOfSize(2 * JSON_LIMIT_BYTES);
const JSON_HEADERS = { "content-type": "application/json" };

const CASES: Case[] = [
  { name: "health-get", method: "GET", path: "/api/health" },
  { name: "health-head", method: "HEAD", path: "/api/health" },
  { name: "health-trailing-slash", method: "GET", path: "/api/health/" },
  { name: "health-uppercase", method: "GET", path: "/API/HEALTH" },
  { name: "health-double-slash", method: "GET", path: "/api/health//" },
  { name: "health-query", method: "GET", path: "/api/health?x=1#frag" },
  {
    name: "health-if-none-match",
    method: "GET",
    path: "/api/health",
    reuse: { case: "health-get", header: "etag", as: "if-none-match" },
  },
  { name: "notfound", method: "GET", path: "/nope", headers: AUTH },
  { name: "notfound-query", method: "GET", path: "/nope?x=<b>", headers: AUTH },
  { name: "notfound-html", method: "GET", path: "/<script>alert('x')</script>", headers: AUTH },
  { name: "notfound-encoded", method: "GET", path: "/%3Cscript%3E%zz", headers: AUTH },
  { name: "notfound-head", method: "HEAD", path: "/nope", headers: AUTH },
  { name: "notfound-post", method: "POST", path: "/nope", headers: { ...AUTH, "content-type": "text/plain" }, body: "x" },
  { name: "notfound-put-authed", method: "PUT", path: "/api/health", headers: AUTH },
  { name: "options-cors", method: "OPTIONS", path: "/api/health", headers: { origin: "http://allowed.example" } },
  { name: "options-plain", method: "OPTIONS", path: "/anything" },
  { name: "cors-get", method: "GET", path: "/api/health", headers: { origin: "http://allowed.example" } },
  { name: "cors-get-other-origin", method: "GET", path: "/api/health", headers: { origin: "http://other.example" } },
  { name: "host-evil", method: "GET", path: "/api/health", headers: { host: "evil.example" } },
  { name: "service-missing", method: "GET", path: "/", headers: { host: "missing.svc.localhost" } },
  {
    name: "service-proxy",
    method: "POST",
    path: "/some/path?q=1",
    headers: { host: "proxy.svc.localhost", "x-forwarded-proto": "https", "content-type": "text/plain" },
    body: "hello upstream",
  },
  { name: "terminal-ok", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: '{"a":1}' },
  { name: "terminal-array", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: "[1]" },
  { name: "terminal-string", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: '"str"' },
  { name: "terminal-malformed", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: "{bad" },
  { name: "terminal-empty", method: "POST", path: "/api/terminal-activity", headers: { ...JSON_HEADERS, "content-length": "0" } },
  { name: "terminal-no-type", method: "POST", path: "/api/terminal-activity", headers: { "content-type": "text/plain" }, body: "{}" },
  { name: "terminal-vendor-type", method: "POST", path: "/api/terminal-activity", headers: { "content-type": "application/vnd.api+json" }, body: "{}" },
  { name: "terminal-bad-type", method: "POST", path: "/api/terminal-activity", headers: { "content-type": "garbage" }, body: "{}" },
  {
    name: "terminal-charset-latin1",
    method: "POST",
    path: "/api/terminal-activity",
    headers: { "content-type": "application/json; charset=latin1" },
    body: "{}",
  },
  {
    name: "terminal-charset-utf8",
    method: "POST",
    path: "/api/terminal-activity",
    headers: { "content-type": 'application/json; charset="UTF-8"' },
    body: "{}",
  },
  {
    name: "terminal-gzip",
    method: "POST",
    path: "/api/terminal-activity",
    headers: { ...JSON_HEADERS, "content-encoding": "gzip" },
    body: gzipSync('{"a":1}'),
  },
  { name: "terminal-too-large", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: BIG_JSON },
  {
    name: "terminal-too-large-chunked",
    method: "POST",
    path: "/api/terminal-activity",
    headers: JSON_HEADERS,
    chunks: [BIG_JSON.slice(0, JSON_LIMIT_BYTES), BIG_JSON.slice(JSON_LIMIT_BYTES)],
  },
  { name: "terminal-at-limit", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: jsonOfSize(JSON_LIMIT_BYTES) },
  { name: "terminal-over-limit-by-one", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: jsonOfSize(JSON_LIMIT_BYTES + 1) },
  { name: "terminal-bom", method: "POST", path: "/api/terminal-activity", headers: JSON_HEADERS, body: "﻿{}" },
  { name: "auth-missing", method: "GET", path: "/api/status" },
  { name: "auth-wrong", method: "GET", path: "/api/status", headers: { authorization: "Bearer nope" } },
  { name: "auth-throws", method: "GET", path: "/api/echo", headers: { ...AUTH, "x-auth-throw": "1" } },
  {
    name: "echo-query",
    method: "GET",
    path: "/api/echo?a=1&a=2&a=3&b=&c&e=x+y&f=%20&g=%E0%A4%A&h=%zz&=v&&constructor=c&toString=t&hasOwnProperty=h",
    headers: { ...AUTH, "x-test": "seen", referer: "http://ref.example/" },
  },
  { name: "echo-query-nested", method: "GET", path: "/api/echo?o[k]=v&arr[]=1", headers: AUTH },
  { name: "echo-query-proto", method: "GET", path: "/api/echo?__proto__=p&x=1", headers: AUTH },
  { name: "echo-forwarded-proto", method: "GET", path: "/api/echo", headers: { ...AUTH, "x-forwarded-proto": "https, http" } },
  { name: "untrusted-forwarded-proto", method: "GET", path: "/api/echo", port: "untrusted", headers: { "x-forwarded-proto": "https" } },
  { name: "trust-all-forwarded-proto", method: "GET", path: "/api/echo", port: "trustAll", headers: { "x-forwarded-proto": "https" } },
  { name: "trust-netmask-peer", method: "GET", path: "/api/echo", port: "untrusted", localAddress: "127.0.0.2", headers: { "x-forwarded-proto": "https" } },
  { name: "trust-mapped-subnet-peer", method: "GET", path: "/api/echo", port: "untrusted", localAddress: "127.0.0.3", headers: { "x-forwarded-proto": "https" } },
  { name: "trust-other-peer", method: "GET", path: "/api/echo", port: "untrusted", localAddress: "127.0.0.4", headers: { "x-forwarded-proto": "https" } },
  {
    name: "echo-body",
    method: "POST",
    path: "/api/echo-body",
    headers: { ...AUTH, ...JSON_HEADERS },
    body: '{"nested":{"a":[1,2,null]},"s":"\\u00e9"}',
  },
  { name: "echo-body-none", method: "POST", path: "/api/echo-body", headers: AUTH },
  { name: "throw", method: "GET", path: "/api/throw", headers: AUTH },
  { name: "reject", method: "GET", path: "/api/reject", headers: AUTH },
  { name: "status-then-throw", method: "GET", path: "/api/status-then-throw", headers: AUTH },
  { name: "next-error", method: "GET", path: "/api/next-error", headers: AUTH },
  { name: "error-after-headers", method: "GET", path: "/api/after-headers", headers: AUTH },
  { name: "header-injection", method: "GET", path: "/api/header-inject", headers: AUTH },
  { name: "download-missing-token", method: "GET", path: "/api/files/download" },
  { name: "download-bad-token", method: "GET", path: "/api/files/download?token=bad" },
  { name: "download-token-array", method: "GET", path: "/api/files/download?token=valid&token=valid" },
  { name: "download-ok", method: "GET", path: "/api/files/download?token=%20valid%20" },
  { name: "download-head", method: "HEAD", path: "/api/files/download?token=valid" },
  { name: "mcp-get", method: "GET", path: "/mcp/agents" },
  { name: "mcp-delete", method: "DELETE", path: "/mcp/agents" },
  {
    name: "mcp-post",
    method: "POST",
    path: "/mcp/agents?callerAgentId=a1&callerAgentId=a2",
    headers: { ...JSON_HEADERS, "mcp-session-id": "s-1" },
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  },
  { name: "ui-index", method: "GET", path: "/ui/", headers: { host: "daemon.example:6767" } },
  { name: "ui-index-forwarded-tls", method: "GET", path: "/ui/", headers: { host: "daemon.example", "x-forwarded-proto": "https" } },
  { name: "ui-head", method: "HEAD", path: "/ui/" },
  { name: "ui-script", method: "GET", path: "/ui/app.js" },
  { name: "static-file", method: "GET", path: "/public/hello.txt" },
  { name: "static-head", method: "HEAD", path: "/public/hello.txt" },
  { name: "static-uppercase-mount", method: "GET", path: "/PUBLIC/hello.txt" },
  { name: "static-query", method: "GET", path: "/public/hello.txt?v=2" },
  { name: "static-index", method: "GET", path: "/public/" },
  { name: "static-mount-redirect", method: "GET", path: "/public" },
  { name: "static-mount-redirect-query", method: "GET", path: "/public?x=1" },
  { name: "static-dir-redirect", method: "GET", path: "/public/sub" },
  { name: "static-dir-redirect-slashes", method: "GET", path: "/public//sub" },
  { name: "static-dir-no-index", method: "GET", path: "/public/sub/" },
  { name: "static-css", method: "GET", path: "/public/sub/a.css" },
  { name: "static-js", method: "GET", path: "/public/app.js" },
  { name: "static-svg", method: "GET", path: "/public/logo.svg" },
  { name: "static-no-extension", method: "GET", path: "/public/README" },
  { name: "static-prototype-extension", method: "GET", path: "/public/odd.constructor" },
  { name: "static-encoded-name", method: "GET", path: "/public/with%20space.txt" },
  { name: "static-missing", method: "GET", path: "/public/nope.txt" },
  { name: "static-file-trailing-slash", method: "GET", path: "/public/hello.txt/" },
  { name: "static-post", method: "POST", path: "/public/hello.txt" },
  {
    name: "static-if-none-match",
    method: "GET",
    path: "/public/hello.txt",
    reuse: { case: "static-file", header: "etag", as: "if-none-match" },
  },
  {
    name: "static-if-modified-since",
    method: "GET",
    path: "/public/hello.txt",
    reuse: { case: "static-file", header: "last-modified", as: "if-modified-since" },
  },
  { name: "static-if-modified-since-old", method: "GET", path: "/public/hello.txt", headers: { "if-modified-since": "Mon, 01 Jan 1990 00:00:00 GMT" } },
  {
    name: "static-no-cache",
    method: "GET",
    path: "/public/hello.txt",
    headers: { "cache-control": "no-cache" },
    reuse: { case: "static-file", header: "etag", as: "if-none-match" },
  },
  { name: "traversal-dotdot", method: "GET", path: "/public/../secret.txt" },
  { name: "traversal-encoded-dots", method: "GET", path: "/public/%2e%2e/secret.txt" },
  { name: "traversal-encoded-slash", method: "GET", path: "/public/..%2fsecret.txt" },
  { name: "traversal-fully-encoded", method: "GET", path: "/public/%2e%2e%2fsecret.txt" },
  { name: "traversal-backslash", method: "GET", path: "/public/..%5csecret.txt" },
  { name: "traversal-double-encoded", method: "GET", path: "/public/%252e%252e/secret.txt" },
  { name: "traversal-deep", method: "GET", path: "/public/sub/../../secret.txt" },
  { name: "traversal-nul", method: "GET", path: "/public/hello.txt%00.png" },
  { name: "traversal-absolute", method: "GET", path: "/public//etc/passwd" },
  { name: "traversal-encoded-absolute", method: "GET", path: "/public/%2Fetc%2Fpasswd" },
  { name: "traversal-malformed-escape", method: "GET", path: "/public/%zz" },
  { name: "static-dotfile", method: "GET", path: "/public/.hidden" },
  { name: "static-dot-directory", method: "GET", path: "/public/.dir/file.txt" },
  { name: "static-symlink-outside", method: "GET", path: "/public/link-out" },
  { name: "static-symlink-inside", method: "GET", path: "/public/link-in" },
  { name: "static-range", method: "GET", path: "/public/hello.txt", headers: { range: "bytes=0-1" } },
  {
    name: "json-on-get-malformed",
    method: "GET",
    path: "/api/echo",
    headers: { ...AUTH, ...JSON_HEADERS },
    body: "{oops",
  },
  {
    name: "echo-query-parameter-limit",
    method: "GET",
    path: `/api/echo?${Array.from({ length: 1001 }, (_, i) => `p${i}=${i}`).join("&")}`,
    headers: AUTH,
  },
];

/** Checks that hold for the module whatever express does. */
function securityFindings(results: Map<string, Result[]>, index: number): string[] {
  const findings: string[] = [];
  const result = (name: string): Result => {
    const found = results.get(name)?.[index];
    if (found === undefined) {
      throw new Error(`no result for ${name}`);
    }
    return found;
  };
  for (const [name, row] of results) {
    const body = row[index]?.body ?? "";
    if (body.includes(SECRET_MARKER)) {
      findings.push(`${name} disclosed the file outside the static root`);
    }
    if (body.includes("<script>alert")) {
      findings.push(`${name} echoed unescaped markup`);
    }
    if (body.includes("secret detail")) {
      findings.push(`${name} echoed an error message`);
    }
    for (const header of Object.keys(row[index]?.headers ?? {})) {
      if (header.startsWith("injected")) {
        findings.push(`${name} let a header through CR/LF`);
      }
    }
  }
  for (const name of CASES.map((item) => item.name).filter((item) => item.startsWith("traversal-"))) {
    if (result(name).status !== "404") {
      findings.push(`${name} answered ${result(name).status}, not 404`);
    }
  }
  const injection = result("header-injection").body;
  if (!injection.includes('"code":"ERR_INVALID_CHAR"') || !injection.includes('"nameCode":"ERR_INVALID_HTTP_TOKEN"')) {
    findings.push(`setHeader accepted CR/LF: ${injection}`);
  }
  for (const name of ["terminal-too-large", "terminal-too-large-chunked", "terminal-over-limit-by-one"]) {
    if (result(name).status !== "413") {
      findings.push(`${name} answered ${result(name).status}, not 413`);
    }
  }
  return findings;
}

function residentBytes(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  if (match === null) {
    throw new Error(`no VmRSS for ${pid}`);
  }
  return Number(match[1]) * 1024;
}

interface MemoryResult {
  status: string;
  growthBytes: number;
}

/** Streams a chunked JSON body far over the limit and measures the server's RSS growth. */
function oversizedBodyMemory(target: Target): Promise<MemoryResult> {
  const pid = target.child.pid;
  if (pid === undefined) {
    throw new Error(`${target.name} has no pid`);
  }
  const before = residentBytes(pid);
  let peak = before;
  const chunk = Buffer.alloc(HUGE_BODY_CHUNK_BYTES, 0x20);
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: target.startup.port,
        method: "POST",
        path: "/api/terminal-activity",
        headers: JSON_HEADERS,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve({ status: String(res.statusCode), growthBytes: peak - before });
        });
      },
    );
    req.on("error", () => {
      resolve({ status: "error", growthBytes: peak - before });
    });
    let sent = 0;
    const writeMore = (): void => {
      while (sent < HUGE_BODY_BYTES) {
        sent += chunk.length;
        peak = Math.max(peak, residentBytes(pid));
        if (!req.write(chunk)) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    };
    req.write("{");
    writeMore();
  });
}

interface IntentionalDifference {
  caseName: string;
  field: string;
}

/** Reads the table between the intentional-differences markers in README.md. */
function readIntentional(readmePath: string): IntentionalDifference[] {
  const text = readFileSync(readmePath, "utf8");
  const start = text.indexOf("<!-- intentional-differences:start -->");
  const end = text.indexOf("<!-- intentional-differences:end -->");
  if (start === -1 || end === -1) {
    throw new Error("README.md has no intentional-differences table");
  }
  const rows: IntentionalDifference[] = [];
  for (const line of text.slice(start, end).split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (cells.length < 4 || cells[1] === "Case" || /^-+$/.test(cells[1] ?? "")) {
      continue;
    }
    rows.push({ caseName: cells[1] ?? "", field: cells[2] ?? "" });
  }
  return rows;
}

function diff(expected: Result, actual: Result): Map<string, string> {
  const out = new Map<string, string>();
  if (expected.status !== actual.status) {
    out.set("status", `${expected.status} != ${actual.status}`);
  }
  if (expected.body !== actual.body) {
    out.set("body", `${JSON.stringify(expected.body)} != ${JSON.stringify(actual.body)}`);
  }
  const names = new Set([...Object.keys(expected.headers), ...Object.keys(actual.headers)]);
  for (const name of [...names].sort()) {
    const a = expected.headers[name];
    const b = actual.headers[name];
    if (a !== b) {
      out.set(`header:${name}`, `${a ?? "<absent>"} != ${b ?? "<absent>"}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  // node itself, not the tsx CLI, so the child pid is the server for the RSS check.
  const node = process.execPath;
  const tsx = ["--import", "tsx"];
  const intentional = readIntentional(env("PROBE_README"));
  const targets: Target[] = [];
  try {
    targets.push(await startTarget("express", node, [...tsx, env("PROBE_EXPRESS_SERVER")], { NODE_ENV: "production" }));
    targets.push(await startTarget("module-node", node, [...tsx, env("PROBE_MODULE_SERVER")], {}));
    targets.push(await startTarget("module-native", env("PROBE_NATIVE_SERVER"), [], {}));
    const results = new Map<string, Result[]>();
    for (const item of CASES) {
      const row: Result[] = [];
      for (const target of targets) {
        const headers: Record<string, string> = { ...item.headers };
        if (item.reuse !== undefined) {
          const earlier = results.get(item.reuse.case)?.[0];
          const value = earlier?.headers[item.reuse.header];
          if (value === undefined) {
            throw new Error(`${item.name}: ${item.reuse.case} has no ${item.reuse.header}`);
          }
          headers[item.reuse.as] = value;
        }
        row.push(await send(target, item, headers));
      }
      results.set(item.name, row);
    }

    let failures = 0;
    const used = new Set<IntentionalDifference>();
    const isIntentional = (caseName: string, field: string): IntentionalDifference | undefined =>
      intentional.find(
        (entry) =>
          (entry.caseName === caseName || entry.caseName === "*") &&
          (entry.field === field || entry.field === "*"),
      );

    const startupFields: (keyof Startup)[] = ["invalidTrust"];
    for (const field of startupFields) {
      for (const target of targets.slice(1)) {
        if (String(target.startup[field]) !== String(targets[0]?.startup[field])) {
          console.log(`FAIL startup ${field} ${target.name}: ${String(targets[0]?.startup[field])} != ${String(target.startup[field])}`);
          failures++;
        }
      }
    }

    for (const item of CASES) {
      const row = results.get(item.name) ?? [];
      const [expressResult, nodeResult, nativeResult] = row;
      if (expressResult === undefined || nodeResult === undefined || nativeResult === undefined) {
        throw new Error(`${item.name}: missing results`);
      }
      const lines: string[] = [];
      for (const [field, detail] of diff(expressResult, nodeResult)) {
        const entry = isIntentional(item.name, field);
        if (entry !== undefined) {
          used.add(entry);
          lines.push(`  intentional ${field}: ${detail}`);
        } else {
          failures++;
          lines.push(`  FAIL express vs module-node ${field}: ${detail}`);
        }
      }
      for (const [field, detail] of diff(nodeResult, nativeResult)) {
        failures++;
        lines.push(`  FAIL module-node vs module-native ${field}: ${detail}`);
      }
      console.log(`${lines.some((line) => line.includes("FAIL")) ? "FAIL" : "ok  "} ${item.name} ${nativeResult.status}`);
      for (const line of lines) {
        console.log(line);
      }
    }
    for (const entry of intentional) {
      if (!used.has(entry)) {
        failures++;
        console.log(`FAIL README lists ${entry.caseName} ${entry.field} as intentional, but it does not differ`);
      }
    }

    for (const [index, target] of targets.entries()) {
      if (index > 0) {
        for (const message of securityFindings(results, index)) {
          failures++;
          console.log(`FAIL security ${target.name}: ${message}`);
        }
      }
      // Garbage Buffers inflate a Node process's RSS until V8 collects them,
      // so only the native binary, which has no collector lag, is held to the bound.
      const memory = await oversizedBodyMemory(target);
      const bounded = target.name !== "module-native" || memory.growthBytes < MAX_DRAIN_GROWTH_BYTES;
      const ok = memory.status === "413" && bounded;
      if (!ok) {
        failures++;
      }
      console.log(
        `${ok ? "ok  " : "FAIL"} ${target.name} drains a ${HUGE_BODY_BYTES >> 20} MiB body: ` +
          `status ${memory.status}, RSS growth ${(memory.growthBytes / 1048576).toFixed(1)} MiB`,
      );
    }
    console.log(`${CASES.length} cases, ${failures} failures`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    for (const target of targets) {
      target.child.kill();
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 2;
});
