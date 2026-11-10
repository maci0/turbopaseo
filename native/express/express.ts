// Express-compatible HTTP routing on node:http, limited to the surface Paseo's
// daemon uses (see INVENTORY.md). Requests and responses are wrapper classes
// that hold the node:http objects in `raw`; nothing mutates a prototype.
// Deliberate differences from express 4 are listed in README.md.
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  STATUS_CODES,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { isIP, type Socket } from "node:net";
import path from "node:path";
import { Writable } from "node:stream";

/** body-parser's default `limit` for `express.json()` (100kb). */
const JSON_BODY_LIMIT_BYTES = 100 * 1024;
/** qs's default `parameterLimit`; later query parameters are ignored. */
const QUERY_PARAMETER_LIMIT = 1000;
/** serve-static's default `maxAge` is 0. */
const STATIC_CACHE_CONTROL = "public, max-age=0";
const STATIC_INDEX_FILE = "index.html";
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV6_GROUPS = 8;
const IPV6_GROUP_BITS = 16;
const IPV4_MAPPED_PREFIX_BITS = IPV6_BITS - IPV4_BITS;

// ---------------------------------------------------------------- types

export type NextFunction = (err?: unknown) => void;
export type RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;
/** Values Paseo passes to `app.set("trust proxy", ...)`. */
export type TrustProxySetting = true | readonly string[];
export type QueryValue = string | string[];
export type Query = Record<string, QueryValue | undefined>;

/** An error carrying an HTTP status, as http-errors creates for body-parser. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ---------------------------------------------------------------- URL helpers

interface SplitUrl {
  pathname: string;
  /** `?` and everything after it, or "" when there is no query. */
  search: string;
}

/** parseurl's split: a `#` ends the URL, the first `?` starts the query. */
function splitUrl(url: string): SplitUrl {
  const hash = url.indexOf("#");
  const withoutHash = hash === -1 ? url : url.slice(0, hash);
  const question = withoutHash.indexOf("?");
  if (question === -1) {
    return { pathname: withoutHash, search: "" };
  }
  return { pathname: withoutHash.slice(0, question), search: withoutHash.slice(question) };
}

/** qs's decoder: `+` is a space, malformed escapes stay as written. */
function decodeQueryComponent(value: string): string {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * Flat qs-style parsing: repeated keys collect into an array. Bracket syntax
 * (`a[b]=c`, `a[]=c`) is not expanded; the key keeps its brackets. Values
 * collect in a Map so keys such as `toString` never read Object.prototype;
 * `__proto__` is dropped.
 */
function parseQuery(search: string): Query {
  const query: Query = {};
  if (search.length <= 1) {
    return query;
  }
  const values = new Map<string, string[]>();
  const parts = search.slice(1).split("&");
  const count = Math.min(parts.length, QUERY_PARAMETER_LIMIT);
  for (let i = 0; i < count; i++) {
    const part = parts[i] ?? "";
    if (part.length === 0) {
      continue;
    }
    const eq = part.indexOf("=");
    const key = decodeQueryComponent(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? "" : decodeQueryComponent(part.slice(eq + 1));
    if (key.length === 0 || key === "__proto__") {
      continue;
    }
    const existing = values.get(key);
    if (existing === undefined) {
      values.set(key, [value]);
    } else {
      existing.push(value);
    }
  }
  for (const [key, list] of values) {
    query[key] = list.length === 1 ? (list[0] ?? "") : list;
  }
  return query;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** encodeurl 2.0: percent-encode what is not allowed in a URL, keep valid escapes. */
function encodeUrl(url: string): string {
  return url
    .replace(
      /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g,
      "$1�$2",
    )
    .replace(
      /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]|%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|$))+/g,
      (chunk) => encodeURI(chunk),
    );
}

function htmlDocument(title: string, body: string): string {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    `<title>${title}</title>\n` +
    "</head>\n" +
    "<body>\n" +
    `<pre>${body}</pre>\n` +
    "</body>\n" +
    "</html>\n"
  );
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  return value.join(", ");
}

/** fresh 0.5: whether a conditional GET matches the response's validators. */
function isFresh(
  headers: IncomingHttpHeaders,
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  const modifiedSince = headerString(headers["if-modified-since"]);
  const noneMatch = headerString(headers["if-none-match"]);
  if (!modifiedSince && !noneMatch) {
    return false;
  }
  const cacheControl = headerString(headers["cache-control"]);
  if (cacheControl && /(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(cacheControl)) {
    return false;
  }
  if (noneMatch && noneMatch !== "*") {
    if (!etag) {
      return false;
    }
    const matched = noneMatch
      .split(",")
      .map((tag) => tag.trim())
      .some((tag) => tag === etag || tag === `W/${etag}` || `W/${tag}` === etag);
    if (!matched) {
      return false;
    }
  }
  if (modifiedSince) {
    if (!lastModified || !(Date.parse(lastModified) <= Date.parse(modifiedSince))) {
      return false;
    }
  }
  return true;
}

/** The etag module's weak tag for a string body, as express's default `etag fn` makes. */
function weakBodyEtag(body: string): string {
  if (body.length === 0) {
    return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  }
  const hash = createHash("sha1").update(body, "utf8").digest("base64").slice(0, 27);
  return `W/"${Buffer.byteLength(body, "utf8").toString(16)}-${hash}"`;
}

function headerText(value: number | string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? String(value) : headerString(value);
}

// ---------------------------------------------------------------- trust proxy

/** An address or subnet in IPv6 space; IPv4 is held as IPv4-mapped IPv6. */
interface Subnet {
  groups: number[];
  prefix: number;
}

interface TrustPolicy {
  all: boolean;
  subnets: Subnet[];
}

/** proxy-addr's named ranges. */
const NAMED_RANGES = new Map<string, string[]>([
  ["linklocal", ["169.254.0.0/16", "fe80::/10"]],
  ["loopback", ["127.0.0.1/8", "::1/128"]],
  ["uniquelocal", ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]],
]);

function parseIpv4Groups(address: string): number[] {
  const octets = address.split(".").map((octet) => Number(octet));
  return [
    0,
    0,
    0,
    0,
    0,
    0xffff,
    ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
    ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
  ];
}

/** Parses an address `net.isIP` accepted into eight 16-bit groups. */
function parseIpGroups(address: string): number[] {
  if (isIP(address) === 4) {
    return parseIpv4Groups(address);
  }
  const zone = address.indexOf("%");
  let text = zone === -1 ? address : address.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Groups(text.slice(lastColon + 1));
    tail = [v4[6] ?? 0, v4[7] ?? 0];
    text = `${text.slice(0, lastColon + 1)}0`;
  }
  const halves = text.split("::");
  const toGroups = (part: string): number[] =>
    part.length === 0 ? [] : part.split(":").map((group) => parseInt(group, 16));
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length > 1 ? toGroups(halves[1] ?? "") : [];
  if (tail.length > 0) {
    // The placeholder "0" stands for the dotted quad; replace it.
    if (rest.length > 0 || halves.length > 1) {
      rest.pop();
    } else {
      head.pop();
    }
  }
  const fill = IPV6_GROUPS - head.length - rest.length - tail.length;
  const groups = [...head];
  for (let i = 0; i < fill; i++) {
    groups.push(0);
  }
  return [...groups, ...rest, ...tail];
}

function isIpv4Mapped(groups: number[]): boolean {
  for (let i = 0; i < 5; i++) {
    if (groups[i] !== 0) {
      return false;
    }
  }
  return groups[5] === 0xffff;
}

function netmaskPrefix(mask: string): number | null {
  const groups = parseIpv4Groups(mask);
  const bits = (((groups[6] ?? 0) << 16) | (groups[7] ?? 0)) >>> 0;
  let prefix = 0;
  while (prefix < IPV4_BITS && ((bits >>> (IPV4_BITS - 1 - prefix)) & 1) === 1) {
    prefix++;
  }
  const expected = prefix === 0 ? 0 : (0xffffffff << (IPV4_BITS - prefix)) >>> 0;
  return bits === expected ? prefix : null;
}

/** proxy-addr's parseipNotation: "ip", "ip/prefix" or "ipv4/netmask". */
function parseSubnet(note: string): Subnet {
  const slash = note.lastIndexOf("/");
  const address = slash === -1 ? note : note.slice(0, slash);
  const family = isIP(address);
  if (family === 0) {
    throw new TypeError(`invalid IP address: ${address}`);
  }
  const groups = parseIpGroups(address);
  const isV4 = family === 4 || (slash === -1 && isIpv4Mapped(groups));
  const max = isV4 ? IPV4_BITS : IPV6_BITS;
  let prefix: number | null = max;
  if (slash !== -1) {
    const range = note.slice(slash + 1);
    if (/^[0-9]+$/.test(range)) {
      prefix = parseInt(range, 10);
    } else if (family === 4 && isIP(range) === 4) {
      prefix = netmaskPrefix(range);
    } else {
      prefix = null;
    }
  }
  if (prefix === null || prefix <= 0 || prefix > max) {
    throw new TypeError(`invalid range on address: ${note}`);
  }
  return { groups, prefix: isV4 ? prefix + IPV4_MAPPED_PREFIX_BITS : prefix };
}

function compileTrust(setting: TrustProxySetting): TrustPolicy {
  if (setting === true) {
    return { all: true, subnets: [] };
  }
  const subnets: Subnet[] = [];
  for (const entry of setting) {
    const named = NAMED_RANGES.get(entry);
    for (const note of named ?? [entry]) {
      subnets.push(parseSubnet(note));
    }
  }
  return { all: false, subnets };
}

function subnetContains(subnet: Subnet, groups: number[]): boolean {
  let remaining = subnet.prefix;
  for (let i = 0; i < IPV6_GROUPS && remaining > 0; i++) {
    const bits = Math.min(remaining, IPV6_GROUP_BITS);
    const mask = (0xffff << (IPV6_GROUP_BITS - bits)) & 0xffff;
    if (((subnet.groups[i] ?? 0) & mask) !== ((groups[i] ?? 0) & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

function isTrusted(policy: TrustPolicy, address: string | undefined): boolean {
  if (policy.all) {
    return true;
  }
  if (address === undefined || isIP(address) === 0) {
    return false;
  }
  const groups = parseIpGroups(address);
  for (const subnet of policy.subnets) {
    if (subnetContains(subnet, groups)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- request

export class Request {
  /** The URL relative to the current mount point; equals `originalUrl` outside one. */
  url: string;
  /** `undefined` until a body parser runs, then `{}` or the parsed JSON. */
  body: unknown = undefined;
  /** Set once a body parser has read the stream, like body-parser's `req._body`. */
  bodyRead = false;
  readonly originalUrl: string;
  readonly query: Query;

  constructor(
    readonly raw: IncomingMessage,
    private readonly trust: TrustPolicy,
  ) {
    this.originalUrl = raw.url ?? "/";
    this.url = this.originalUrl;
    this.query = parseQuery(splitUrl(this.originalUrl).search);
  }

  get method(): string {
    return this.raw.method ?? "GET";
  }

  get headers(): IncomingHttpHeaders {
    return this.raw.headers;
  }

  get socket(): Socket {
    return this.raw.socket;
  }

  /** The pathname of `url`, still percent-encoded. */
  get path(): string {
    return splitUrl(this.url).pathname;
  }

  /**
   * "http", or the first X-Forwarded-Proto entry when the peer is a trusted
   * proxy. This module serves node:http only, so the socket is never TLS.
   */
  get protocol(): string {
    if (!isTrusted(this.trust, this.raw.socket.remoteAddress)) {
      return "http";
    }
    const forwarded = headerString(this.raw.headers["x-forwarded-proto"]) ?? "http";
    const comma = forwarded.indexOf(",");
    return (comma === -1 ? forwarded : forwarded.slice(0, comma)).trim();
  }

  /** Case-insensitive header read; `Referer` and `Referrer` are interchangeable. */
  header(name: string): string | undefined {
    const lower = name.toLowerCase();
    if (lower === "referer" || lower === "referrer") {
      return headerString(this.raw.headers.referrer) ?? headerString(this.raw.headers.referer);
    }
    return headerString(this.raw.headers[lower]);
  }

  /**
   * Pipes the request body into an upstream request and ends it, as
   * `IncomingMessage.pipe(destination, { end: true })`. scriptc lowers only the
   * one-argument form, whose `end` default is the same.
   */
  pipe(destination: ClientRequest, _options?: { end: true }): ClientRequest {
    this.raw.pipe(destination);
    return destination;
  }
}

// ---------------------------------------------------------------- response

function withUtf8Charset(contentType: string): string {
  const params = contentType
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const type = (params.shift() ?? "").toLowerCase();
  const kept = params.filter((param) => !param.toLowerCase().startsWith("charset="));
  return [type, ...kept, "charset=utf-8"].join("; ");
}

/**
 * A Writable over the node:http response so that `readable.pipe(res)` from a
 * file stream compiles natively; scriptc lowers a pipe into a Writable subclass
 * but not into a ServerResponse. Each written chunk goes to `raw.write`, `end`
 * goes to `raw.end`. There is no backpressure: a native ServerResponse.write
 * reports nothing, so a client slower than the source makes the response
 * buffer in memory. `destroyed` turns true and `close` is emitted when the
 * node:http response closes. An IncomingMessage cannot be piped here natively;
 * pipe it into `raw`.
 */
export class Response extends Writable {
  constructor(
    readonly raw: ServerResponse,
    private readonly req: Request,
  ) {
    super({ autoDestroy: false });
    raw.once("close", () => {
      this.destroy();
    });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.raw.write(chunk);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.raw.end();
    callback();
  }

  get headersSent(): boolean {
    return this.raw.headersSent;
  }

  get statusCode(): number {
    return this.raw.statusCode;
  }

  status(code: number): this {
    this.raw.statusCode = code;
    return this;
  }

  /** node:http validates the name and value and throws on CR, LF and other invalid characters. */
  setHeader(name: string, value: string | number | readonly string[]): this {
    this.raw.setHeader(name, value);
    return this;
  }

  writeHead(status: number, headers?: OutgoingHttpHeaders): this {
    if (headers === undefined) {
      this.raw.writeHead(status);
    } else {
      this.raw.writeHead(status, headers);
    }
    return this;
  }

  /** `JSON.stringify` the value and send it as application/json. */
  json(value: unknown): this {
    const text = JSON.stringify(value);
    if (this.raw.getHeader("content-type") === undefined) {
      this.raw.setHeader("Content-Type", "application/json");
    }
    return this.send(text);
  }

  /**
   * Send a string body (text/html unless a Content-Type is set) with a weak
   * ETag, answering 304 to a matching conditional GET, and end the response.
   */
  send(body: string): this {
    const raw = this.raw;
    const contentType = raw.getHeader("content-type");
    raw.setHeader(
      "Content-Type",
      typeof contentType === "string" ? withUtf8Charset(contentType) : "text/html; charset=utf-8",
    );
    raw.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
    if (raw.getHeader("etag") === undefined) {
      raw.setHeader("ETag", weakBodyEtag(body));
    }
    const method = this.req.method;
    const current = raw.statusCode;
    if (
      (method === "GET" || method === "HEAD") &&
      ((current >= 200 && current < 300) || current === 304) &&
      isFresh(
        this.req.headers,
        headerText(raw.getHeader("etag")),
        headerText(raw.getHeader("last-modified")),
      )
    ) {
      raw.statusCode = 304;
    }
    const status = raw.statusCode;
    if (status === 204 || status === 304) {
      this.raw.removeHeader("Content-Type");
      this.raw.removeHeader("Content-Length");
      this.raw.removeHeader("Transfer-Encoding");
      this.raw.end();
      return this;
    }
    if (status === 205) {
      this.raw.setHeader("Content-Length", "0");
      this.raw.removeHeader("Transfer-Encoding");
      this.raw.end();
      return this;
    }
    if (this.req.method === "HEAD") {
      this.raw.end();
    } else {
      this.raw.end(body);
    }
    return this;
  }
}

// ---------------------------------------------------------------- final handler

function errorStatus(err: unknown, res: ServerResponse): number {
  if (err instanceof HttpError && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  const current = res.statusCode;
  return current >= 400 && current <= 599 ? current : 500;
}

/** finalhandler 1.3 in production mode: never echoes error text or stacks. */
function finish(req: Request, res: Response, err: unknown): void {
  const raw = res.raw;
  let status: number;
  let message: string;
  if (err) {
    status = errorStatus(err, raw);
    message = STATUS_CODES[status] ?? String(status);
  } else {
    if (raw.headersSent) {
      return;
    }
    status = 404;
    message = `Cannot ${req.method} ${encodeUrl(splitUrl(req.originalUrl).pathname)}`;
  }
  if (raw.headersSent) {
    req.raw.socket.destroy();
    return;
  }
  const write = (): void => {
    const body = htmlDocument(
      "Error",
      escapeHtml(message).replace(/\n/g, "<br>").replace(/\x20{2}/g, " &nbsp;"),
    );
    raw.statusCode = status;
    raw.removeHeader("Content-Encoding");
    raw.removeHeader("Content-Language");
    raw.removeHeader("Content-Range");
    raw.setHeader("Content-Security-Policy", "default-src 'none'");
    raw.setHeader("X-Content-Type-Options", "nosniff");
    raw.setHeader("Content-Type", "text/html; charset=utf-8");
    raw.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
    if (req.method === "HEAD") {
      raw.end();
    } else {
      raw.end(body);
    }
  };
  whenRequestFinished(req.raw, write);
}

/** Runs `then` once the request body is consumed, draining what is left unread. */
function whenRequestFinished(raw: IncomingMessage, then: () => void): void {
  if (raw.complete || raw.destroyed) {
    then();
    return;
  }
  let done = false;
  const once = (): void => {
    if (!done) {
      done = true;
      then();
    }
  };
  raw.once("end", once);
  raw.once("close", once);
  raw.resume();
}

// ---------------------------------------------------------------- application

interface Layer {
  /** null for `app.use(handler)`, else the uppercase method of a route. */
  method: string | null;
  /** Mount prefix for `use` layers (null mounts at the root), exact path for routes. */
  path: string | null;
  handler: RequestHandler;
}

/** path-to-regexp 0.1 with `end: true`: case-insensitive, optional trailing slash. */
function matchesRoute(route: string, pathname: string): boolean {
  const lowerPath = pathname.toLowerCase();
  const lowerRoute = route.toLowerCase();
  return lowerPath === lowerRoute || lowerPath === `${lowerRoute}/`;
}

/** Length of the URL prefix a mount at `prefix` removes, or -1 when it does not match. */
function mountedPrefixLength(prefix: string, pathname: string): number {
  const lowerPath = pathname.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerPath.startsWith(lowerPrefix)) {
    return -1;
  }
  const rest = lowerPath.slice(lowerPrefix.length);
  if (rest === "" || rest.startsWith("/")) {
    return rest === "/" ? lowerPrefix.length + 1 : lowerPrefix.length;
  }
  return -1;
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath.startsWith("/")) {
    throw new TypeError(`mount path must start with "/": ${mountPath}`);
  }
  return mountPath.endsWith("/") ? mountPath.slice(0, -1) : mountPath;
}

/**
 * `true` or an array of strings. The value is `unknown` because express's
 * `app.set` takes any value and Paseo passes config-store values unnarrowed.
 */
function toTrustProxySetting(value: unknown): TrustProxySetting {
  if (value === true) {
    return true;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    const entries: string[] = [];
    for (const item of items) {
      if (typeof item !== "string") {
        throw new TypeError("trust proxy entries must be strings");
      }
      entries.push(item);
    }
    return entries;
  }
  throw new TypeError("trust proxy must be true or an array of strings");
}

class Router {
  private readonly layers: Layer[] = [];
  /** express's default `trust proxy` is false. */
  private trust: TrustPolicy = { all: false, subnets: [] };

  setTrustProxy(value: unknown): void {
    this.trust = compileTrust(toTrustProxySetting(value));
  }

  use(pathOrHandler: string | RequestHandler, handler?: RequestHandler): void {
    if (typeof pathOrHandler === "string") {
      if (handler === undefined) {
        throw new TypeError("app.use() requires a middleware function");
      }
      const prefix = normalizeMountPath(pathOrHandler);
      this.layers.push({ method: null, path: prefix === "" ? null : prefix, handler });
    } else {
      this.layers.push({ method: null, path: null, handler: pathOrHandler });
    }
  }

  route(method: string, routePath: string, handlers: RequestHandler[]): void {
    if (handlers.length === 0) {
      throw new TypeError(`app.${method.toLowerCase()}() requires a callback function`);
    }
    for (const handler of handlers) {
      this.layers.push({ method, path: routePath, handler });
    }
  }

  handle(rawReq: IncomingMessage, rawRes: ServerResponse): void {
    const req = new Request(rawReq, this.trust);
    const res = new Response(rawRes, req);
    const layers = this.layers;
    let index = 0;

    const next = (err?: unknown): void => {
      if (err) {
        req.url = req.originalUrl;
        finish(req, res, err);
        return;
      }
      while (index < layers.length) {
        const layer = layers[index];
        index++;
        if (layer === undefined) {
          break;
        }
        req.url = req.originalUrl;
        const pathname = splitUrl(req.url).pathname;
        if (layer.method !== null) {
          const methodMatches =
            layer.method === req.method || (layer.method === "GET" && req.method === "HEAD");
          if (!methodMatches || layer.path === null || !matchesRoute(layer.path, pathname)) {
            continue;
          }
        } else if (layer.path !== null) {
          const removed = mountedPrefixLength(layer.path, pathname);
          if (removed === -1) {
            continue;
          }
          const rest = req.url.slice(removed);
          req.url = rest.startsWith("/") ? rest : `/${rest}`;
        }
        invoke(layer.handler);
        return;
      }
      req.url = req.originalUrl;
      finish(req, res, undefined);
    };

    const invoke = (handler: RequestHandler): void => {
      try {
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.then(undefined, (reason: unknown) => {
            next(reason ? reason : new Error("Rejected promise"));
          });
        }
      } catch (thrown) {
        next(thrown ? thrown : new Error("Handler threw a falsy value"));
      }
    };

    next();
  }
}

// ---------------------------------------------------------------- express.json()

interface MediaType {
  type: string;
  charset: string | undefined;
}

function parseMediaType(header: string | undefined): MediaType | null {
  if (header === undefined) {
    return null;
  }
  const parts = header.split(";");
  const type = (parts[0] ?? "").trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    return null;
  }
  let charset: string | undefined;
  for (const param of parts.slice(1)) {
    const eq = param.indexOf("=");
    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === "charset") {
      charset = param
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .toLowerCase();
    }
  }
  return { type, charset };
}

/** type-is's hasBody: a Transfer-Encoding header or a numeric Content-Length. */
function hasBody(raw: IncomingMessage): boolean {
  const length = raw.headers["content-length"];
  return (
    raw.headers["transfer-encoding"] !== undefined ||
    (length !== undefined && !Number.isNaN(Number(length)))
  );
}

/** body-parser's strict mode accepts only an object or an array at the top level. */
function parseStrictJson(text: string): unknown {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  if (body.length === 0) {
    return {};
  }
  const first = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/.exec(body);
  if (first === null || (first[1] !== "{" && first[1] !== "[")) {
    throw new HttpError(400, "invalid JSON body");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * Parses `application/json` bodies of at most 100kb into `req.body`. Other
 * requests pass through with `req.body = {}`. The limit is checked against
 * Content-Length before reading and against the bytes received while reading;
 * an oversized body is drained, never buffered.
 */
function json(): RequestHandler {
  return (req, _res, next) => {
    if (req.bodyRead) {
      next();
      return;
    }
    if (req.body === undefined) {
      req.body = {};
    }
    const raw = req.raw;
    if (!hasBody(raw)) {
      next();
      return;
    }
    const media = parseMediaType(headerString(raw.headers["content-type"]));
    if (media === null || media.type !== "application/json") {
      next();
      return;
    }
    const charset = media.charset ?? "utf-8";
    if (charset !== "utf-8") {
      next(new HttpError(415, "unsupported charset"));
      return;
    }
    const encoding = (headerString(raw.headers["content-encoding"]) ?? "identity").toLowerCase();
    if (encoding !== "identity") {
      next(new HttpError(415, "unsupported content encoding"));
      return;
    }
    req.bodyRead = true;
    const declared = raw.headers["content-length"];
    let failure: HttpError | null =
      declared !== undefined && Number(declared) > JSON_BODY_LIMIT_BYTES
        ? new HttpError(413, "request entity too large")
        : null;
    let chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const settle = (err: HttpError | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (err !== null) {
        next(err);
        return;
      }
      try {
        req.body = parseStrictJson(Buffer.concat(chunks).toString("utf8"));
      } catch (parseError) {
        next(parseError);
        return;
      }
      next();
    };
    raw.on("data", (chunk: Buffer) => {
      if (failure !== null) {
        return;
      }
      received += chunk.length;
      if (received > JSON_BODY_LIMIT_BYTES) {
        failure = new HttpError(413, "request entity too large");
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    raw.once("end", () => {
      settle(failure);
    });
    raw.once("close", () => {
      if (!raw.complete) {
        settle(new HttpError(400, "request aborted"));
      }
    });
  };
}

// ---------------------------------------------------------------- express.static()

/** mime 1.6 types for the extensions a web asset directory holds; others are octet-stream. */
const MIME_TYPES = new Map<string, string>([
  ["css", "text/css"],
  ["csv", "text/csv"],
  ["eot", "application/vnd.ms-fontobject"],
  ["gif", "image/gif"],
  ["gz", "application/gzip"],
  ["htm", "text/html"],
  ["html", "text/html"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", "application/javascript"],
  ["json", "application/json"],
  ["map", "application/json"],
  ["md", "text/markdown"],
  ["mjs", "application/javascript"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["ogg", "audio/ogg"],
  ["otf", "font/otf"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["ttf", "font/ttf"],
  ["txt", "text/plain"],
  ["wasm", "application/wasm"],
  ["wav", "audio/wav"],
  ["webm", "video/webm"],
  ["webmanifest", "application/manifest+json"],
  ["webp", "image/webp"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["xml", "application/xml"],
  ["zip", "application/zip"],
]);

/** send's Content-Type: mime 1.6 lookup plus `charset=UTF-8` for text and JS/JSON. */
function staticContentType(filePath: string): string {
  const ext = filePath.replace(/^.*[./\\]/, "").toLowerCase();
  const type = MIME_TYPES.get(ext) ?? "application/octet-stream";
  return /^text\/|^application\/(javascript|json)/.test(type) ? `${type}; charset=UTF-8` : type;
}

/** send's UP_PATH_REGEXP: a `..` segment, with `/` or `\` as separator. */
const UP_PATH = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function collapseLeadingSlashes(text: string): string {
  let i = 0;
  while (i < text.length && text.charCodeAt(i) === 0x2f) {
    i++;
  }
  return i > 1 ? `/${text.slice(i)}` : text;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** send's onStatError: these codes are a 404, anything else a 500. */
function isMissingFile(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

/**
 * Serves regular files under `root` for GET and HEAD, with `index.html` for
 * directories and a 301 to add a directory's trailing slash. Anything it will
 * not serve (missing file, `..` segment, NUL byte, malformed escape, dot
 * segment, symlink resolving outside root) falls through to `next()`.
 */
function serveStatic(root: string): RequestHandler {
  const rootPath = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    let requestPath = req.path;
    if (requestPath === "/" && !splitUrl(req.originalUrl).pathname.endsWith("/")) {
      requestPath = "";
    }
    const decoded = safeDecode(requestPath);
    if (decoded === null || decoded.includes("\0")) {
      next();
      return;
    }
    const relative = decoded.length > 0 ? path.posix.normalize(`./${decoded}`) : decoded;
    if (UP_PATH.test(relative)) {
      next();
      return;
    }
    if (relative.split("/").some((part) => part.length > 1 && part.startsWith("."))) {
      next();
      return;
    }
    const target = path.normalize(path.join(rootPath, relative));
    const filePath = requestPath.endsWith("/") ? path.join(target, STATIC_INDEX_FILE) : target;
    void serveFile(req, res, next, rootPath, filePath);
  };
}

async function serveFile(
  req: Request,
  res: Response,
  next: NextFunction,
  rootPath: string,
  filePath: string,
): Promise<void> {
  let stats: Stats;
  let realRoot: string;
  let realFile: string;
  try {
    stats = await stat(filePath);
    if (stats.isDirectory()) {
      // A directory named with a trailing slash has no index file.
      if (filePath.endsWith(STATIC_INDEX_FILE)) {
        next();
      } else {
        redirectToDirectory(req, res);
      }
      return;
    }
    realRoot = await realpath(rootPath);
    realFile = await realpath(filePath);
  } catch (err) {
    if (isMissingFile(err)) {
      next();
    } else {
      next(err);
    }
    return;
  }
  if (!isInside(realRoot, realFile) || !stats.isFile()) {
    next();
    return;
  }
  writeFile(req, res, filePath, stats, next);
}

function redirectToDirectory(req: Request, res: Response): void {
  const original = splitUrl(req.originalUrl);
  const location = encodeUrl(collapseLeadingSlashes(`${original.pathname}/`) + original.search);
  const doc = htmlDocument("Redirecting", `Redirecting to ${escapeHtml(location)}`);
  const raw = res.raw;
  raw.statusCode = 301;
  raw.setHeader("Content-Type", "text/html; charset=UTF-8");
  raw.setHeader("Content-Length", Buffer.byteLength(doc));
  raw.setHeader("Content-Security-Policy", "default-src 'none'");
  raw.setHeader("X-Content-Type-Options", "nosniff");
  raw.setHeader("Location", location);
  if (req.method === "HEAD") {
    raw.end();
  } else {
    raw.end(doc);
  }
}

function writeFile(
  req: Request,
  res: Response,
  filePath: string,
  stats: Stats,
  next: NextFunction,
): void {
  const raw = res.raw;
  if (raw.headersSent) {
    next(new HttpError(500, "headers already sent"));
    return;
  }
  const lastModified = stats.mtime.toUTCString();
  const etag = `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`;
  if (raw.getHeader("cache-control") === undefined) {
    raw.setHeader("Cache-Control", STATIC_CACHE_CONTROL);
  }
  if (raw.getHeader("last-modified") === undefined) {
    raw.setHeader("Last-Modified", lastModified);
  }
  if (raw.getHeader("etag") === undefined) {
    raw.setHeader("ETag", etag);
  }
  if (raw.getHeader("content-type") === undefined) {
    raw.setHeader("Content-Type", staticContentType(filePath));
  }
  const status = raw.statusCode;
  const cacheable = (status >= 200 && status < 300) || status === 304;
  if (cacheable && isFresh(req.headers, etag, lastModified)) {
    for (const name of raw.getHeaderNames()) {
      if (name.startsWith("content-") && name !== "content-location") {
        raw.removeHeader(name);
      }
    }
    raw.statusCode = 304;
    raw.end();
    return;
  }
  raw.setHeader("Content-Length", stats.size);
  if (req.method === "HEAD") {
    raw.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", (err) => {
    next(err);
  });
  res.once("close", () => {
    stream.destroy();
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------- default export

/**
 * An application is the node:http request listener, as in express:
 * `http.createServer(app)`.
 */
export interface Application {
  (req: IncomingMessage, res: ServerResponse): void;
  /** Only `trust proxy` is supported; invalid values and addresses throw, as in express. */
  set(setting: "trust proxy", value: unknown): Application;
  /** `use(handler)` mounts at the root; `use("/prefix", handler)` strips the prefix from `req.url`. */
  use(pathOrHandler: string | RequestHandler, handler?: RequestHandler): Application;
  get(routePath: string, ...handlers: RequestHandler[]): Application;
  post(routePath: string, ...handlers: RequestHandler[]): Application;
  delete(routePath: string, ...handlers: RequestHandler[]): Application;
}

/** Creates an application: the request listener with the methods assigned onto it. */
function express(): Application {
  const router = new Router();
  const app = (req: IncomingMessage, res: ServerResponse): void => {
    router.handle(req, res);
  };
  app.set = (_setting: "trust proxy", value: unknown): Application => {
    router.setTrustProxy(value);
    return app;
  };
  app.use = (pathOrHandler: string | RequestHandler, handler?: RequestHandler): Application => {
    router.use(pathOrHandler, handler);
    return app;
  };
  app.get = (routePath: string, ...handlers: RequestHandler[]): Application => {
    router.route("GET", routePath, handlers);
    return app;
  };
  app.post = (routePath: string, ...handlers: RequestHandler[]): Application => {
    router.route("POST", routePath, handlers);
    return app;
  };
  app.delete = (routePath: string, ...handlers: RequestHandler[]): Application => {
    router.route("DELETE", routePath, handlers);
    return app;
  };
  return app;
}

type ExpressRequest = Request;
type ExpressResponse = Response;
type ExpressApplication = Application;
type ExpressRequestHandler = RequestHandler;
type ExpressNextFunction = NextFunction;

/** Type names reachable as `express.Request` etc., as with @types/express. */
namespace express {
  export type Request = ExpressRequest;
  export type Response = ExpressResponse;
  export type Application = ExpressApplication;
  export type RequestHandler = ExpressRequestHandler;
  export type NextFunction = ExpressNextFunction;
}

express.json = json;
express.static = serveStatic;

export default express;
