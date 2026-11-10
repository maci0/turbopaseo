// RFC 6455 WebSocket on node:net and node:tls, for scriptc native builds where
// the npm `ws` package cannot run. Members, event names, and argument shapes
// follow ws 8.20; README.md lists what differs. No extensions are offered.
import * as net from "node:net";
import * as tls from "node:tls";
import { createHash, randomBytes } from "node:crypto";
import type { Agent } from "node:http";

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;
const READY_STATE_NAMES = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];

/** RFC 6455 section 1.3. */
export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** ws's default maxPayload: 100 MiB. 0 disables the limit. */
export const DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;
/** ws's closeTimeout: how long to wait for the peer to finish a close. */
const CLOSE_TIMEOUT_MS = 30_000;
/** Node's default --max-http-header-size, applied to the handshake response. */
const MAX_HANDSHAKE_HEADER_BYTES = 16 * 1024;
/** Unmasked frames below this size go out as one write; larger ones as two. */
const SINGLE_WRITE_FRAME_BYTES = 16 * 1024;
const MAX_CONTROL_PAYLOAD_BYTES = 125;
const MAX_CLOSE_REASON_BYTES = 123;
const KEY_BYTES = 16;
const MASK_BYTES = 4;
const LENGTH_16_MARKER = 126;
const LENGTH_64_MARKER = 127;
const MAX_16_BIT_LENGTH = 0xffff;
/** Payload lengths whose upper 32 bits exceed this cannot be a JS number. */
const MAX_SAFE_UPPER_32 = 2 ** 21 - 1;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

const CLOSE_NO_STATUS = 1005;
const CLOSE_ABNORMAL = 1006;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_INVALID_DATA = 1007;
const CLOSE_TOO_BIG = 1009;

const EMPTY_BUFFER: Buffer = Buffer.alloc(0);
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.0-9A-Z^_`|~a-z]+$/;
const HTTP_TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const INVALID_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export type BinaryType = "nodebuffer" | "arraybuffer";
export type SendCallback = (error?: Error) => void;

export type OpenListener = () => void;
export type MessageListener = (data: Buffer, isBinary: boolean) => void;
export type CloseListener = (code: number, reason: Buffer) => void;
export type ErrorListener = (error: Error) => void;
export type PingListener = (data: Buffer) => void;
export type UpgradeListener = (response: HandshakeResponse) => void;
export type UnexpectedResponseListener = (request: null, response: HandshakeResponse) => void;
/** A listener of any event, as Paseo's `WebSocketLike` registers them. */
export type WebSocketListener = (...args: unknown[]) => void;
export type WebSocketEventListener = (event: WebSocketEvent) => void;

export interface ClientOptions {
  headers?: Record<string, string>;
  /** Refused when set: proxies are not implemented. */
  agent?: Agent;
  /** Ignored, as ws ignores it: a ws+unix: URL names the socket. */
  socketPath?: string;
  maxPayload?: number;
  handshakeTimeout?: number;
  /** Only `false` is accepted: no extension is ever offered. */
  perMessageDeflate?: boolean;
  /** Accepted for ws compatibility and ignored: one address is dialed. */
  autoSelectFamilyAttemptTimeout?: number;
  /** TLS trust anchors (PEM) for wss:. */
  ca?: string;
  rejectUnauthorized?: boolean;
}

export interface SendOptions {
  binary?: boolean;
  fin?: boolean;
  mask?: boolean;
  /** Accepted for ws compatibility and ignored. */
  compress?: boolean;
}

/** The handshake response, as `'upgrade'` and `'unexpected-response'` report it. */
export class HandshakeResponse {
  readonly statusCode: number;
  readonly statusMessage: string;
  /** Lowercased names; repeated headers joined with ", " as Node does. */
  readonly headers: Record<string, string>;
  private readonly socket: net.Socket;

  constructor(
    statusCode: number,
    statusMessage: string,
    headers: Record<string, string>,
    socket: net.Socket,
  ) {
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    this.socket = socket;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/**
 * An error the frame parser raised; `statusCode` is the close code sent. A
 * RangeError, as ws raises, except invalid UTF-8 (WebSocketUtf8Error).
 */
export class WebSocketFrameError extends RangeError {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** ws raises invalid UTF-8 as a plain Error. */
export class WebSocketUtf8Error extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** The event objects that addEventListener and the on* properties receive. */
export class WebSocketEvent {
  readonly type: string;
  readonly target: WebSocket;

  constructor(type: string, target: WebSocket) {
    this.type = type;
    this.target = target;
  }
}

export class WebSocketMessageEvent extends WebSocketEvent {
  /** A string for text; a Buffer or an ArrayBuffer (binaryType) for binary. */
  readonly data: unknown;

  constructor(target: WebSocket, data: unknown) {
    super("message", target);
    this.data = data;
  }
}

export class WebSocketCloseEvent extends WebSocketEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(target: WebSocket, code: number, reason: string, wasClean: boolean) {
    super("close", target);
    this.code = code;
    this.reason = reason;
    this.wasClean = wasClean;
  }
}

export class WebSocketErrorEvent extends WebSocketEvent {
  readonly error: Error;
  readonly message: string;

  constructor(target: WebSocket, error: Error) {
    super("error", target);
    this.error = error;
    this.message = error.message;
  }
}

/** One addEventListener registration; `detach` unregisters its wrapper. */
class EventTargetEntry {
  readonly type: string;
  readonly listener: WebSocketEventListener;
  readonly detach: () => void;

  constructor(type: string, listener: WebSocketEventListener, detach: () => void) {
    this.type = type;
    this.listener = listener;
    this.detach = detach;
  }
}

/** Listeners of one event, in registration order, as EventEmitter keeps them. */
class ListenerList<L> {
  private listeners: L[] = [];
  private onceFlags: boolean[] = [];

  add(listener: L, once: boolean): void {
    this.listeners.push(listener);
    this.onceFlags.push(once);
  }

  /** Removes the most recently added registration of `listener`. */
  remove(listener: L): void {
    for (let i = this.listeners.length - 1; i >= 0; i--) {
      if (this.listeners[i] === listener) {
        this.listeners.splice(i, 1);
        this.onceFlags.splice(i, 1);
        return;
      }
    }
  }

  /** The listeners to call for one emit; `once` registrations are dropped first. */
  take(): L[] {
    const current = this.listeners.slice();
    if (this.onceFlags.includes(true)) {
      const kept: L[] = [];
      const keptFlags: boolean[] = [];
      for (let i = 0; i < this.listeners.length; i++) {
        if (this.onceFlags[i]) continue;
        kept.push(this.listeners[i]!);
        keptFlags.push(false);
      }
      this.listeners = kept;
      this.onceFlags = keptFlags;
    }
    return current;
  }

  get size(): number {
    return this.listeners.length;
  }
}

function isValidStatusCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

function isValidUtf8(data: Buffer): boolean {
  try {
    utf8.decode(data);
  } catch {
    // TextDecoder with fatal: true throws a TypeError for malformed input only.
    return false;
  }
  return true;
}

export function acceptKeyFor(key: string): string {
  return createHash("sha1")
    .update(key + WEBSOCKET_GUID)
    .digest("base64");
}

function toBuffer(data: string | Uint8Array | ArrayBuffer): Buffer {
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function frameHeader(opcode: number, fin: boolean, length: number, mask: Buffer | null): Buffer {
  const lengthBytes = length > MAX_16_BIT_LENGTH ? 8 : length > MAX_CONTROL_PAYLOAD_BYTES ? 2 : 0;
  const header = Buffer.allocUnsafe(2 + lengthBytes + (mask === null ? 0 : MASK_BYTES));
  header[0] = (fin ? 0x80 : 0) | opcode;
  const maskBit = mask === null ? 0 : 0x80;
  if (lengthBytes === 0) {
    header[1] = maskBit | length;
  } else if (lengthBytes === 2) {
    header[1] = maskBit | LENGTH_16_MARKER;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = maskBit | LENGTH_64_MARKER;
    header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    header.writeUInt32BE(length % 2 ** 32, 6);
  }
  if (mask !== null) mask.copy(header, 2 + lengthBytes);
  return header;
}

function maskedCopy(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i & 3]!;
  return out;
}

function unmaskInPlace(payload: Buffer, mask: Buffer): void {
  for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
}

/** The errors node:http throws for a bad request header, with Node's codes. */
class HeaderError extends TypeError {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function validateHeader(name: string, value: string): void {
  if (!HTTP_TOKEN.test(name)) {
    throw new HeaderError(
      `Header name must be a valid HTTP token ["${name}"]`,
      "ERR_INVALID_HTTP_TOKEN",
    );
  }
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new HeaderError(`Invalid character in header content ["${name}"]`, "ERR_INVALID_CHAR");
  }
}

/** Where and how the client dials, from the URL and options. */
class ConnectTarget {
  host = "";
  port = 0;
  socketPath = "";
  secure = false;
  path = "/";
  hostHeader = "";
}

function resolveTarget(address: string): ConnectTarget {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    // new URL throws a TypeError for input it cannot parse; ws reports a SyntaxError.
    throw new SyntaxError(`Invalid URL: ${address}`);
  }
  let protocol = parsed.protocol;
  if (protocol === "http:") protocol = "ws:";
  else if (protocol === "https:") protocol = "wss:";
  const isIpc = protocol === "ws+unix:";
  if (protocol !== "ws:" && protocol !== "wss:" && !isIpc) {
    throw new SyntaxError(
      'The URL\'s protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"',
    );
  }
  if (isIpc && !parsed.pathname) throw new SyntaxError("The URL's pathname is empty");
  if (parsed.hash) throw new SyntaxError("The URL contains a fragment identifier");
  if (parsed.username || parsed.password) {
    throw new SyntaxError("ws native: credentials in the URL are not supported");
  }
  const target = new ConnectTarget();
  target.secure = protocol === "wss:";
  const defaultPort = target.secure ? 443 : 80;
  target.port = parsed.port ? Number(parsed.port) : defaultPort;
  target.host = parsed.hostname.startsWith("[")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  target.path = parsed.pathname + parsed.search;
  if (isIpc) {
    const parts = target.path.split(":");
    target.socketPath = parts[0]!;
    target.path = parts[1] ?? "";
  }
  if (target.socketPath !== "" || target.host === "") target.hostHeader = "localhost";
  else target.hostHeader = target.port === defaultPort ? parsed.hostname : parsed.host;
  return target;
}

interface ResponseHead {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
}

/** Splits a raw response head into status and lowercased headers, or null. */
function parseResponseHead(head: string): ResponseHead | null {
  const lines = head.split("\r\n");
  const status = STATUS_LINE.exec(lines[0] ?? "");
  if (status === null) return null;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const previous = headers[name];
    headers[name] = previous === undefined ? value : `${previous}, ${value}`;
  }
  return { statusCode: Number(status[1]), statusMessage: status[2] ?? "", headers };
}

export class WebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readyState: number = CONNECTING;
  /** Bytes queued on the socket plus bytes of sends made after close began. */
  bufferedAmount = 0;
  /** Affects addEventListener/onmessage data only; 'message' listeners get Buffers. */
  binaryType: BinaryType = "nodebuffer";
  protocol = "";
  readonly extensions = "";
  readonly url: string;

  onopen: WebSocketEventListener | null = null;
  onmessage: WebSocketEventListener | null = null;
  onclose: WebSocketEventListener | null = null;
  onerror: WebSocketEventListener | null = null;

  private readonly isServer: boolean;
  private readonly maxPayload: number;
  private socket: net.Socket | null = null;
  private unsentBytes = 0;
  private paused = false;
  private closeCode = CLOSE_ABNORMAL;
  private closeMessage: Buffer = EMPTY_BUFFER;
  private closeFrameReceived = false;
  private closeFrameSent = false;
  private receiverErrored = false;
  private errorEmitted = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** After 'unexpected-response', the response owns the socket. */
  private responseHandedOff = false;
  private sendingFragmented = false;

  // Frame parser state.
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private reading = false;
  private frameFin = false;
  private frameOpcode = 0;
  private frameMasked = false;
  private framePayloadLength = 0;
  private frameMask: Buffer = EMPTY_BUFFER;
  private parseState = 0;
  private fragmentedOpcode = 0;
  private fragments: Buffer[] = [];
  private fragmentsBytes = 0;

  private readonly openListeners = new ListenerList<OpenListener>();
  private readonly messageListeners = new ListenerList<MessageListener>();
  private readonly closeListeners = new ListenerList<CloseListener>();
  private readonly errorListeners = new ListenerList<ErrorListener>();
  private readonly pingListeners = new ListenerList<PingListener>();
  private readonly pongListeners = new ListenerList<PingListener>();
  private readonly upgradeListeners = new ListenerList<UpgradeListener>();
  private readonly unexpectedResponseListeners = new ListenerList<UnexpectedResponseListener>();
  /** addEventListener registrations, to find each one's wrapper again. */
  private readonly eventTargetEntries: EventTargetEntry[] = [];

  /**
   * `address` null makes a server-side socket that WebSocketServer attaches
   * with setSocket(); every other address dials at once.
   */
  constructor(
    address: string | null,
    protocols?: string | string[] | ClientOptions,
    options?: ClientOptions,
  ) {
    let protocolList: string[] = [];
    let clientOptions: ClientOptions = options ?? {};
    if (typeof protocols === "string") protocolList = [protocols];
    else if (Array.isArray(protocols)) protocolList = protocols;
    else if (protocols !== undefined) clientOptions = protocols;
    this.isServer = address === null;
    this.maxPayload = clientOptions.maxPayload ?? DEFAULT_MAX_PAYLOAD;
    this.url = address ?? "";
    if (address !== null) this.connect(address, protocolList, clientOptions);
  }

  // Listener registration -------------------------------------------------
  //
  // The implementations take the listener as `unknown` and cast it to the
  // event's type: scriptc 0.4.10 refuses or mis-holds the alternatives (a
  // union of listener types, `(...args: never[]) => void`); see
  // probes/overload-arity.ts. The overloads keep call sites typed.

  on(event: "open", listener: OpenListener): this;
  on(event: "message", listener: MessageListener): this;
  on(event: "close", listener: CloseListener): this;
  on(event: "error", listener: ErrorListener): this;
  on(event: "ping" | "pong", listener: PingListener): this;
  on(event: "upgrade", listener: UpgradeListener): this;
  on(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  on(event: string, listener: WebSocketListener): this;
  on(event: string, listener: unknown): this {
    this.register(event, listener, false);
    return this;
  }

  once(event: "open", listener: OpenListener): this;
  once(event: "message", listener: MessageListener): this;
  once(event: "close", listener: CloseListener): this;
  once(event: "error", listener: ErrorListener): this;
  once(event: "ping" | "pong", listener: PingListener): this;
  once(event: "upgrade", listener: UpgradeListener): this;
  once(event: "unexpected-response", listener: UnexpectedResponseListener): this;
  once(event: string, listener: WebSocketListener): this;
  once(event: string, listener: unknown): this {
    this.register(event, listener, true);
    return this;
  }

  off(event: string, listener: unknown): this {
    switch (event) {
      case "open":
        this.openListeners.remove(listener as OpenListener);
        break;
      case "message":
        this.messageListeners.remove(listener as MessageListener);
        break;
      case "close":
        this.closeListeners.remove(listener as CloseListener);
        break;
      case "error":
        this.errorListeners.remove(listener as ErrorListener);
        break;
      case "ping":
        this.pingListeners.remove(listener as PingListener);
        break;
      case "pong":
        this.pongListeners.remove(listener as PingListener);
        break;
      case "upgrade":
        this.upgradeListeners.remove(listener as UpgradeListener);
        break;
      case "unexpected-response":
        this.unexpectedResponseListeners.remove(listener as UnexpectedResponseListener);
        break;
      default:
        throw new TypeError(`ws native: unsupported event "${event}"`);
    }
    return this;
  }

  removeListener(event: string, listener: unknown): this {
    return this.off(event, listener);
  }

  listenerCount(event: string): number {
    switch (event) {
      case "open":
        return this.openListeners.size;
      case "message":
        return this.messageListeners.size;
      case "close":
        return this.closeListeners.size;
      case "error":
        return this.errorListeners.size;
      case "ping":
        return this.pingListeners.size;
      case "pong":
        return this.pongListeners.size;
      case "upgrade":
        return this.upgradeListeners.size;
      case "unexpected-response":
        return this.unexpectedResponseListeners.size;
      default:
        throw new TypeError(`ws native: unsupported event "${event}"`);
    }
  }

  private register(event: string, listener: unknown, once: boolean): void {
    switch (event) {
      case "open":
        this.openListeners.add(listener as OpenListener, once);
        break;
      case "message":
        this.messageListeners.add(listener as MessageListener, once);
        break;
      case "close":
        this.closeListeners.add(listener as CloseListener, once);
        break;
      case "error":
        this.errorListeners.add(listener as ErrorListener, once);
        break;
      case "ping":
        this.pingListeners.add(listener as PingListener, once);
        break;
      case "pong":
        this.pongListeners.add(listener as PingListener, once);
        break;
      case "upgrade":
        this.upgradeListeners.add(listener as UpgradeListener, once);
        break;
      case "unexpected-response":
        this.unexpectedResponseListeners.add(listener as UnexpectedResponseListener, once);
        break;
      default:
        throw new TypeError(`ws native: unsupported event "${event}"`);
    }
  }

  /** EventTarget-style registration; other types are ignored, as in ws. */
  addEventListener(
    type: string,
    listener: WebSocketEventListener,
    options?: { once?: boolean },
  ): void {
    if (this.eventTargetIndex(type, listener) !== -1) return;
    const once = options?.once === true;
    const fired = (): void => {
      if (!once) return;
      const index = this.eventTargetIndex(type, listener);
      if (index !== -1) this.eventTargetEntries.splice(index, 1);
    };
    let detach: () => void;
    if (type === "open") {
      const wrapper = (): void => {
        fired();
        listener(new WebSocketEvent("open", this));
      };
      this.openListeners.add(wrapper, once);
      detach = () => this.openListeners.remove(wrapper);
    } else if (type === "message") {
      const wrapper = (data: Buffer, isBinary: boolean): void => {
        fired();
        listener(new WebSocketMessageEvent(this, this.eventData(data, isBinary)));
      };
      this.messageListeners.add(wrapper, once);
      detach = () => this.messageListeners.remove(wrapper);
    } else if (type === "close") {
      const wrapper = (code: number, reason: Buffer): void => {
        fired();
        listener(new WebSocketCloseEvent(this, code, reason.toString(), this.wasClean()));
      };
      this.closeListeners.add(wrapper, once);
      detach = () => this.closeListeners.remove(wrapper);
    } else if (type === "error") {
      const wrapper = (error: Error): void => {
        fired();
        listener(new WebSocketErrorEvent(this, error));
      };
      this.errorListeners.add(wrapper, once);
      detach = () => this.errorListeners.remove(wrapper);
    } else {
      return;
    }
    this.eventTargetEntries.push(new EventTargetEntry(type, listener, detach));
  }

  removeEventListener(type: string, listener: WebSocketEventListener): void {
    const index = this.eventTargetIndex(type, listener);
    if (index === -1) return;
    const entry = this.eventTargetEntries[index]!;
    this.eventTargetEntries.splice(index, 1);
    entry.detach();
  }

  private eventTargetIndex(type: string, listener: WebSocketEventListener): number {
    return this.eventTargetEntries.findIndex(
      (entry) => entry.type === type && entry.listener === listener,
    );
  }

  private eventData(data: Buffer, isBinary: boolean): unknown {
    if (!isBinary) return data.toString();
    if (this.binaryType === "arraybuffer") {
      const copy = new ArrayBuffer(data.length);
      new Uint8Array(copy).set(data);
      return copy;
    }
    return data;
  }

  private wasClean(): boolean {
    return this.closeFrameReceived && this.closeFrameSent;
  }

  // Emitters ----------------------------------------------------------------

  private emitOpen(): void {
    for (const listener of this.openListeners.take()) listener();
    this.onopen?.(new WebSocketEvent("open", this));
  }

  private emitMessage(data: Buffer, isBinary: boolean): void {
    for (const listener of this.messageListeners.take()) listener(data, isBinary);
    this.onmessage?.(new WebSocketMessageEvent(this, this.eventData(data, isBinary)));
  }

  private emitError(error: Error): void {
    const listeners = this.errorListeners.take();
    if (listeners.length === 0 && this.onerror === null) throw error;
    for (const listener of listeners) listener(error);
    this.onerror?.(new WebSocketErrorEvent(this, error));
  }

  private emitClose(): void {
    this.readyState = CLOSED;
    this.clearTimers();
    const code = this.closeCode;
    const reason = this.closeMessage;
    for (const listener of this.closeListeners.take()) listener(code, reason);
    this.onclose?.(new WebSocketCloseEvent(this, code, reason.toString(), this.wasClean()));
  }

  private clearTimers(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.closeTimer = null;
    this.handshakeTimer = null;
  }

  // Client handshake --------------------------------------------------------

  private connect(address: string, protocols: string[], options: ClientOptions): void {
    if (options.agent !== undefined) {
      throw new TypeError("ws native: the agent option (proxies) is not supported");
    }
    if (options.perMessageDeflate === true) {
      throw new TypeError("ws native: permessage-deflate is not supported");
    }
    const target = resolveTarget(address);
    const protocolSet = new Set<string>();
    for (const protocol of protocols) {
      if (!SUBPROTOCOL_TOKEN.test(protocol) || protocolSet.has(protocol)) {
        throw new SyntaxError("An invalid or duplicated subprotocol was specified");
      }
      protocolSet.add(protocol);
    }
    const key = randomBytes(KEY_BYTES).toString("base64");
    const request = this.handshakeRequest(target, key, protocols, options.headers ?? {});

    let socket: net.Socket;
    const onConnect = (): void => {
      socket.write(request);
    };
    if (target.socketPath !== "") {
      socket = net.connect({ path: target.socketPath }, onConnect);
    } else if (target.secure) {
      socket = tls.connect(
        {
          host: target.host,
          port: target.port,
          servername: net.isIP(target.host) === 0 ? target.host : undefined,
          ca: options.ca,
          rejectUnauthorized: options.rejectUnauthorized ?? true,
        },
        onConnect,
      );
    } else {
      socket = net.connect({ host: target.host, port: target.port }, onConnect);
    }
    this.socket = socket;

    if (options.handshakeTimeout !== undefined && options.handshakeTimeout > 0) {
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        this.abortHandshake("Opening handshake has timed out");
      }, options.handshakeTimeout);
    }

    let head = EMPTY_BUFFER;
    // Stays registered after the handshake (scriptc has no Socket.off); the
    // readyState guard hands later chunks to the frame parser's own listener.
    socket.on("data", (chunk: Buffer) => {
      if (this.readyState !== CONNECTING || this.responseHandedOff) return;
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HANDSHAKE_HEADER_BYTES) {
          this.failConnecting(new Error("Parse Error: Header overflow"));
        }
        return;
      }
      this.handleResponse(
        socket,
        head.subarray(0, end).toString("latin1"),
        head.subarray(end + 4),
        key,
        protocolSet,
      );
    });
    socket.on("error", (error: Error) => {
      if (this.socket !== socket) return;
      if (this.readyState === CONNECTING) {
        if (!this.responseHandedOff) this.failConnecting(error);
        return;
      }
      // After the handshake ws reports socket errors only as a 1006 close.
      this.readyState = CLOSING;
      socket.destroy();
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      if (this.readyState === CONNECTING) {
        if (!this.responseHandedOff) {
          const hangUp = new Error("socket hang up");
          this.failConnecting(hangUp);
        }
        return;
      }
      this.onSocketClose();
    });
  }

  private handshakeRequest(
    target: ConnectTarget,
    key: string,
    protocols: string[],
    custom: Record<string, string>,
  ): string {
    const headers = new Map<string, string>();
    const names = new Map<string, string>();
    const put = (name: string, value: string): void => {
      validateHeader(name, value);
      const lower = name.toLowerCase();
      names.set(lower, name);
      headers.set(lower, value);
    };
    for (const name of Object.keys(custom)) put(name, custom[name]!);
    put("Sec-WebSocket-Version", "13");
    put("Sec-WebSocket-Key", key);
    put("Connection", "Upgrade");
    put("Upgrade", "websocket");
    if (protocols.length > 0) put("Sec-WebSocket-Protocol", protocols.join(","));
    if (!headers.has("host")) put("Host", target.hostHeader);
    let request = `GET ${target.path} HTTP/1.1\r\n`;
    for (const [lower, value] of headers) request += `${names.get(lower)}: ${value}\r\n`;
    return request + "\r\n";
  }

  private handleResponse(
    socket: net.Socket,
    head: string,
    rest: Buffer,
    key: string,
    protocolSet: Set<string>,
  ): void {
    const parsed: ResponseHead | null = parseResponseHead(head);
    if (parsed === null) {
      this.failConnecting(new Error("Parse Error: Invalid HTTP response"));
      return;
    }
    const response = new HandshakeResponse(
      parsed.statusCode,
      parsed.statusMessage,
      parsed.headers,
      socket,
    );
    const headers = parsed.headers;
    if (parsed.statusCode !== 101) {
      if (this.unexpectedResponseListeners.size > 0) {
        this.responseHandedOff = true;
        for (const listener of this.unexpectedResponseListeners.take()) listener(null, response);
        return;
      }
      this.abortHandshake(`Unexpected server response: ${parsed.statusCode}`);
      return;
    }
    for (const listener of this.upgradeListeners.take()) listener(response);
    if (this.readyState !== CONNECTING) return;

    const upgrade = headers["upgrade"];
    if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") {
      this.abortHandshake("Invalid Upgrade header");
      return;
    }
    if (headers["sec-websocket-accept"] !== acceptKeyFor(key)) {
      this.abortHandshake("Invalid Sec-WebSocket-Accept header");
      return;
    }
    const serverProtocol = headers["sec-websocket-protocol"];
    let protocolError = "";
    if (serverProtocol !== undefined) {
      if (protocolSet.size === 0) {
        protocolError = "Server sent a subprotocol but none was requested";
      } else if (!protocolSet.has(serverProtocol)) {
        protocolError = "Server sent an invalid subprotocol";
      }
    } else if (protocolSet.size > 0) {
      protocolError = "Server sent no subprotocol";
    }
    if (protocolError !== "") {
      this.abortHandshake(protocolError);
      return;
    }
    if (headers["sec-websocket-extensions"] !== undefined) {
      this.abortHandshake(
        "Server sent a Sec-WebSocket-Extensions header but no extension was requested",
      );
      return;
    }
    if (serverProtocol !== undefined) this.protocol = serverProtocol;
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.attach(socket, rest);
  }

  /** ws's abortHandshake: CLOSING now, then 'error' and a 1006 'close'. */
  private abortHandshake(message: string): void {
    this.readyState = CLOSING;
    const error = new Error(message);
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    process.nextTick(() => this.emitErrorAndClose(error));
  }

  /** ws's emitErrorAndClose for errors of the connection attempt itself. */
  private failConnecting(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.emitErrorAndClose(error);
  }

  private emitErrorAndClose(error: Error): void {
    this.readyState = CLOSING;
    this.errorEmitted = true;
    this.emitError(error);
    this.emitClose();
  }

  // Open connection ---------------------------------------------------------

  /** Takes over an upgraded socket. WebSocketServer calls this for server sockets. */
  setSocket(socket: net.Socket, head: Buffer): void {
    this.socket = socket;
    socket.on("error", () => {
      if (this.socket !== socket) return;
      this.readyState = CLOSING;
      socket.destroy();
    });
    socket.on("close", () => {
      if (this.socket === socket) this.onSocketClose();
    });
    this.attach(socket, head);
  }

  private attach(socket: net.Socket, head: Buffer): void {
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("end", () => {
      if (this.socket !== socket) return;
      this.readyState = CLOSING;
      socket.end();
    });
    this.readyState = OPEN;
    this.reading = true;
    this.emitOpen();
    // Frames that arrived with the handshake are parsed on the next tick, as
    // ws does by unshifting them: WebSocketServer hands the socket to its
    // 'connection' listeners only after setSocket returns.
    if (head.length > 0) {
      this.chunks.push(head);
      this.bufferedBytes += head.length;
      process.nextTick(() => this.parse());
    }
  }

  private onSocketClose(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.reading = false;
    this.emitClose();
  }

  pause(): void {
    if (this.readyState === CONNECTING || this.readyState === CLOSED) return;
    this.paused = true;
    this.socket?.pause();
  }

  resume(): void {
    if (this.readyState === CONNECTING || this.readyState === CLOSED) return;
    this.paused = false;
    this.socket?.resume();
    this.parse();
  }

  // Sending -------------------------------------------------------------------

  send(data: string | Uint8Array | ArrayBuffer, cb?: SendCallback): void;
  send(data: string | Uint8Array | ArrayBuffer, options: SendOptions, cb?: SendCallback): void;
  send(
    data: string | Uint8Array | ArrayBuffer,
    optionsOrCallback?: SendOptions | SendCallback,
    cb?: SendCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : cb;
    const options: SendOptions =
      typeof optionsOrCallback === "function" || optionsOrCallback === undefined
        ? {}
        : optionsOrCallback;
    if (this.readyState === CONNECTING) {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    }
    const payload = toBuffer(data);
    if (this.readyState !== OPEN) {
      this.sendAfterClose(payload.length, callback);
      return;
    }
    const binary = options.binary ?? typeof data !== "string";
    const fin = options.fin ?? true;
    const mask = options.mask ?? !this.isServer;
    let opcode = binary ? OPCODE_BINARY : OPCODE_TEXT;
    if (this.sendingFragmented) opcode = OPCODE_CONTINUATION;
    this.sendingFragmented = !fin;
    this.writeFrame(opcode, fin, payload, mask, callback);
  }

  ping(data?: string | Buffer, mask?: boolean, cb?: SendCallback): void {
    this.sendControl(OPCODE_PING, data, mask, cb);
  }

  pong(data?: string | Buffer, mask?: boolean, cb?: SendCallback): void {
    this.sendControl(OPCODE_PONG, data, mask, cb);
  }

  private sendControl(
    opcode: number,
    data: string | Buffer | undefined,
    mask: boolean | undefined,
    cb: SendCallback | undefined,
  ): void {
    if (this.readyState === CONNECTING) {
      throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
    }
    const payload = data === undefined ? EMPTY_BUFFER : toBuffer(data);
    if (this.readyState !== OPEN) {
      this.sendAfterClose(payload.length, cb);
      return;
    }
    if (payload.length > MAX_CONTROL_PAYLOAD_BYTES) {
      throw new RangeError("The data size must not be greater than 125 bytes");
    }
    this.writeFrame(opcode, true, payload, mask ?? !this.isServer, cb);
  }

  private sendAfterClose(length: number, cb: SendCallback | undefined): void {
    this.unsentBytes += length;
    this.refreshBufferedAmount();
    if (cb === undefined) return;
    const error = new Error(
      `WebSocket is not open: readyState ${this.readyState} (${READY_STATE_NAMES[this.readyState]})`,
    );
    process.nextTick(() => cb(error));
  }

  private writeFrame(
    opcode: number,
    fin: boolean,
    payload: Buffer,
    mask: boolean,
    cb: SendCallback | undefined,
  ): void {
    const socket = this.socket;
    if (socket === null) return;
    const done = (error?: Error | null): void => {
      this.refreshBufferedAmount();
      if (cb === undefined) return;
      if (error === undefined || error === null) cb();
      else cb(error);
    };
    if (mask) {
      const key = randomBytes(MASK_BYTES);
      const header = frameHeader(opcode, fin, payload.length, key);
      socket.write(Buffer.concat([header, maskedCopy(payload, key)]), done);
    } else {
      const header = frameHeader(opcode, fin, payload.length, null);
      if (payload.length < SINGLE_WRITE_FRAME_BYTES) {
        socket.write(Buffer.concat([header, payload]), done);
      } else {
        socket.write(header);
        socket.write(payload, done);
      }
    }
    this.refreshBufferedAmount();
  }

  private refreshBufferedAmount(): void {
    const socket = this.socket;
    this.bufferedAmount = (socket === null ? 0 : socket.writableLength) + this.unsentBytes;
  }

  // Closing -------------------------------------------------------------------

  close(code?: number, reason?: string | Buffer): void {
    if (this.readyState === CLOSED) return;
    if (this.readyState === CONNECTING) {
      this.abortHandshake("WebSocket was closed before the connection was established");
      return;
    }
    const socket = this.socket;
    if (this.readyState === CLOSING) {
      if (this.closeFrameSent && (this.closeFrameReceived || this.receiverErrored)) socket?.end();
      return;
    }
    // CLOSING before validation, as ws: an invalid code throws and leaves the
    // socket CLOSING with no close frame sent.
    this.readyState = CLOSING;
    const payload = this.closePayload(code, reason);
    if (socket === null) return;
    this.writeFrame(OPCODE_CLOSE, true, payload, !this.isServer, (error) => {
      if (error !== undefined) return;
      this.closeFrameSent = true;
      if (this.closeFrameReceived || this.receiverErrored) socket.end();
    });
    this.closeTimer = setTimeout(() => socket.destroy(), CLOSE_TIMEOUT_MS);
  }

  private closePayload(code: number | undefined, reason: string | Buffer | undefined): Buffer {
    if (code === undefined) return EMPTY_BUFFER;
    if (!isValidStatusCode(code)) {
      throw new TypeError("First argument must be a valid error code number");
    }
    const reasonBytes = reason === undefined ? EMPTY_BUFFER : toBuffer(reason);
    if (reasonBytes.length > MAX_CLOSE_REASON_BYTES) {
      throw new RangeError("The message must not be greater than 123 bytes");
    }
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    return payload;
  }

  terminate(): void {
    if (this.readyState === CLOSED) return;
    if (this.readyState === CONNECTING) {
      this.abortHandshake("WebSocket was closed before the connection was established");
      return;
    }
    if (this.socket !== null) {
      this.readyState = CLOSING;
      this.socket.destroy();
    }
  }

  // Receiving -------------------------------------------------------------------

  private receive(chunk: Buffer): void {
    if (!this.reading) return;
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    this.parse();
  }

  private consume(n: number): Buffer {
    this.bufferedBytes -= n;
    const first = this.chunks[0]!;
    if (n === first.length) return this.chunks.shift()!;
    if (n < first.length) {
      this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0]!;
      const take = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    return out;
  }

  /** Runs the frame state machine over buffered bytes until it needs more. */
  private parse(): void {
    while (this.reading && !this.paused) {
      if (this.parseState === 0) {
        if (this.bufferedBytes < 2) return;
        if (!this.readFrameInfo(this.consume(2))) return;
      } else if (this.parseState === 1) {
        if (this.bufferedBytes < 2) return;
        this.framePayloadLength = this.consume(2).readUInt16BE(0);
        if (!this.checkLength()) return;
      } else if (this.parseState === 2) {
        if (this.bufferedBytes < 8) return;
        const bytes = this.consume(8);
        const upper = bytes.readUInt32BE(0);
        if (upper > MAX_SAFE_UPPER_32) {
          this.protocolError(
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            CLOSE_TOO_BIG,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH",
          );
          return;
        }
        this.framePayloadLength = upper * 2 ** 32 + bytes.readUInt32BE(4);
        if (!this.checkLength()) return;
      } else if (this.parseState === 3) {
        if (this.bufferedBytes < MASK_BYTES) return;
        this.frameMask = this.consume(MASK_BYTES);
        this.parseState = 4;
      } else {
        if (this.bufferedBytes < this.framePayloadLength) return;
        const payload =
          this.framePayloadLength === 0 ? EMPTY_BUFFER : this.consume(this.framePayloadLength);
        if (this.frameMasked && payload.length > 0) unmaskInPlace(payload, this.frameMask);
        this.parseState = 0;
        this.handleFrame(payload);
      }
    }
  }

  private readFrameInfo(bytes: Buffer): boolean {
    const b0 = bytes[0]!;
    const b1 = bytes[1]!;
    if ((b0 & 0x30) !== 0) {
      return this.protocolError(
        "Invalid WebSocket frame: RSV2 and RSV3 must be clear",
        CLOSE_PROTOCOL_ERROR,
        "WS_ERR_UNEXPECTED_RSV_2_3",
      );
    }
    if ((b0 & 0x40) !== 0) {
      return this.protocolError(
        "Invalid WebSocket frame: RSV1 must be clear",
        CLOSE_PROTOCOL_ERROR,
        "WS_ERR_UNEXPECTED_RSV_1",
      );
    }
    this.frameFin = (b0 & 0x80) !== 0;
    this.frameOpcode = b0 & 0x0f;
    this.framePayloadLength = b1 & 0x7f;
    const opcode = this.frameOpcode;
    if (opcode === OPCODE_CONTINUATION) {
      if (this.fragmentedOpcode === 0) {
        return this.protocolError(
          "Invalid WebSocket frame: invalid opcode 0",
          CLOSE_PROTOCOL_ERROR,
          "WS_ERR_INVALID_OPCODE",
        );
      }
    } else if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (this.fragmentedOpcode !== 0) {
        return this.protocolError(
          `Invalid WebSocket frame: invalid opcode ${opcode}`,
          CLOSE_PROTOCOL_ERROR,
          "WS_ERR_INVALID_OPCODE",
        );
      }
    } else if (opcode === OPCODE_CLOSE || opcode === OPCODE_PING || opcode === OPCODE_PONG) {
      if (!this.frameFin) {
        return this.protocolError(
          "Invalid WebSocket frame: FIN must be set",
          CLOSE_PROTOCOL_ERROR,
          "WS_ERR_EXPECTED_FIN",
        );
      }
      if (
        this.framePayloadLength > MAX_CONTROL_PAYLOAD_BYTES ||
        (opcode === OPCODE_CLOSE && this.framePayloadLength === 1)
      ) {
        return this.protocolError(
          `Invalid WebSocket frame: invalid payload length ${this.framePayloadLength}`,
          CLOSE_PROTOCOL_ERROR,
          "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH",
        );
      }
    } else {
      return this.protocolError(
        `Invalid WebSocket frame: invalid opcode ${opcode}`,
        CLOSE_PROTOCOL_ERROR,
        "WS_ERR_INVALID_OPCODE",
      );
    }
    if (!this.frameFin && this.fragmentedOpcode === 0) this.fragmentedOpcode = opcode;
    this.frameMasked = (b1 & 0x80) !== 0;
    if (this.isServer && !this.frameMasked) {
      return this.protocolError(
        "Invalid WebSocket frame: MASK must be set",
        CLOSE_PROTOCOL_ERROR,
        "WS_ERR_EXPECTED_MASK",
      );
    }
    if (!this.isServer && this.frameMasked) {
      return this.protocolError(
        "Invalid WebSocket frame: MASK must be clear",
        CLOSE_PROTOCOL_ERROR,
        "WS_ERR_UNEXPECTED_MASK",
      );
    }
    if (this.framePayloadLength === LENGTH_16_MARKER) this.parseState = 1;
    else if (this.framePayloadLength === LENGTH_64_MARKER) this.parseState = 2;
    else return this.checkLength();
    return true;
  }

  /** maxPayload applies to the whole message, across its fragments. */
  private checkLength(): boolean {
    if (this.frameOpcode < OPCODE_CLOSE && this.framePayloadLength > 0) {
      const total = this.fragmentsBytes + this.framePayloadLength;
      if (this.maxPayload > 0 && total > this.maxPayload) {
        return this.protocolError(
          "Max payload size exceeded",
          CLOSE_TOO_BIG,
          "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
        );
      }
    }
    this.parseState = this.frameMasked ? 3 : 4;
    return true;
  }

  private handleFrame(payload: Buffer): void {
    const opcode = this.frameOpcode;
    if (opcode === OPCODE_CLOSE) {
      this.handleCloseFrame(payload);
      return;
    }
    if (opcode === OPCODE_PING) {
      this.pong(payload, !this.isServer, () => {});
      for (const listener of this.pingListeners.take()) listener(payload);
      return;
    }
    if (opcode === OPCODE_PONG) {
      for (const listener of this.pongListeners.take()) listener(payload);
      return;
    }
    if (payload.length > 0) {
      this.fragments.push(payload);
      this.fragmentsBytes += payload.length;
    }
    if (!this.frameFin) return;
    const messageOpcode = opcode === OPCODE_CONTINUATION ? this.fragmentedOpcode : opcode;
    const data =
      this.fragments.length === 1
        ? this.fragments[0]!
        : Buffer.concat(this.fragments, this.fragmentsBytes);
    this.fragments = [];
    this.fragmentsBytes = 0;
    this.fragmentedOpcode = 0;
    if (messageOpcode === OPCODE_TEXT && !isValidUtf8(data)) {
      this.protocolError(
        "Invalid WebSocket frame: invalid UTF-8 sequence",
        CLOSE_INVALID_DATA,
        "WS_ERR_INVALID_UTF8",
      );
      return;
    }
    this.emitMessage(data, messageOpcode === OPCODE_BINARY);
  }

  private handleCloseFrame(payload: Buffer): void {
    let code = CLOSE_NO_STATUS;
    let reason = EMPTY_BUFFER;
    if (payload.length > 0) {
      code = payload.readUInt16BE(0);
      if (!isValidStatusCode(code)) {
        this.protocolError(
          `Invalid WebSocket frame: invalid status code ${code}`,
          CLOSE_PROTOCOL_ERROR,
          "WS_ERR_INVALID_CLOSE_CODE",
        );
        return;
      }
      reason = payload.subarray(2);
      if (!isValidUtf8(reason)) {
        this.protocolError(
          "Invalid WebSocket frame: invalid UTF-8 sequence",
          CLOSE_INVALID_DATA,
          "WS_ERR_INVALID_UTF8",
        );
        return;
      }
    }
    this.stopReading();
    this.closeFrameReceived = true;
    this.closeCode = code;
    this.closeMessage = reason;
    if (code === CLOSE_NO_STATUS) this.close();
    else this.close(code, reason);
  }

  /** Drops further input; the socket keeps flowing so its 'end' arrives. */
  private stopReading(): void {
    this.reading = false;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.socket?.resume();
  }

  /** ws's receiverOnError: stop reading, close with the status, emit once. */
  private protocolError(message: string, statusCode: number, code: string): boolean {
    this.stopReading();
    this.receiverErrored = true;
    this.close(statusCode);
    if (!this.errorEmitted) {
      this.errorEmitted = true;
      let error: Error;
      if (statusCode === CLOSE_INVALID_DATA) error = new WebSocketUtf8Error(message, statusCode, code);
      else error = new WebSocketFrameError(message, statusCode, code);
      this.emitError(error);
    }
    return false;
  }
}
