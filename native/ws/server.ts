// The server half of ws 8.20's API, for scriptc native builds: attaches to an
// existing node:http server's 'upgrade' event, or runs with `noServer` and
// handleUpgrade(). README.md lists what differs from ws.
import * as net from "node:net";
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import { DEFAULT_MAX_PAYLOAD, WebSocket, acceptKeyFor } from "./client.js";

const KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/;
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.0-9A-Z^_`|~a-z]+$/;
const SUPPORTED_VERSIONS = "13, 8";
const RUNNING = 0;
const CLOSING = 1;
const CLOSED = 2;

/** ws also passes `secure`; scriptc cannot test a net.Socket for TLS (no `in`, no instanceof). */
export interface VerifyClientInfo {
  origin: string | undefined;
  req: IncomingMessage;
}

export type VerifyClientCallback = (
  result: boolean,
  code?: number,
  message?: string,
  headers?: Record<string, string>,
) => void;

export interface ServerOptions {
  /** Attach to this server's 'upgrade' event. */
  server?: Server;
  /** The caller passes upgrades to handleUpgrade() itself. */
  noServer?: boolean;
  /** Accept only this request path (query string ignored). */
  path?: string;
  maxPayload?: number;
  /** Track open sockets in `clients` (default true). */
  clientTracking?: boolean;
  handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string | false;
  /** The two-argument (asynchronous) form only. */
  verifyClient?: (info: VerifyClientInfo, callback: VerifyClientCallback) => void;
}

export type ConnectionListener = (socket: WebSocket, request: IncomingMessage) => void;
export type CloseCallback = () => void;

/** Ends the socket with a plain HTTP error response, as ws's abortHandshake. */
function rejectUpgrade(
  socket: net.Socket,
  code: number,
  message?: string,
  extraHeaders?: Record<string, string>,
): void {
  const statusText = STATUS_CODES[code] ?? "";
  const body = message ?? statusText;
  const headers: Record<string, string> = {
    Connection: "close",
    "Content-Type": "text/html",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  if (extraHeaders !== undefined) {
    for (const name of Object.keys(extraHeaders)) headers[name] = extraHeaders[name]!;
  }
  let response = `HTTP/1.1 ${code} ${statusText}\r\n`;
  for (const name of Object.keys(headers)) response += `${name}: ${headers[name]}\r\n`;
  socket.end(response + "\r\n" + body, () => socket.destroy());
}

/** Parses a Sec-WebSocket-Protocol header; null when malformed or duplicated. */
function parseProtocols(header: string): Set<string> | null {
  const protocols = new Set<string>();
  for (const part of header.split(",")) {
    const protocol = part.trim();
    if (!SUBPROTOCOL_TOKEN.test(protocol) || protocols.has(protocol)) return null;
    protocols.add(protocol);
  }
  return protocols;
}

export class WebSocketServer {
  /** Open sockets, when clientTracking is on. */
  readonly clients = new Set<WebSocket>();
  private readonly options: ServerOptions;
  private readonly trackClients: boolean;
  private state = RUNNING;
  private emitCloseWhenEmpty = false;
  private readonly connectionListeners: ConnectionListener[] = [];
  /** close() callbacks: each runs on the next close only. */
  private closeCallbacks: CloseCallback[] = [];

  constructor(options: ServerOptions) {
    const hasServer = options.server !== undefined;
    if (hasServer === (options.noServer === true)) {
      throw new TypeError(
        'ws native: exactly one of the "server" or "noServer" options must be specified',
      );
    }
    this.options = options;
    this.trackClients = options.clientTracking ?? true;
    const server = options.server;
    if (server !== undefined) {
      server.on("upgrade", (request: IncomingMessage, socket: net.Socket, head: Buffer) => {
        if (this.state !== RUNNING) return;
        this.handleUpgrade(request, socket, head, (ws, req) => this.emitConnection(ws, req));
      });
    }
  }

  /**
   * Only 'connection': ws's 'close' is covered by close(callback), and scriptc
   * refuses casting a union of fixed-signature listeners to one arm (SC1090).
   */
  on(event: "connection", listener: ConnectionListener): this {
    if (event !== "connection") {
      throw new TypeError(`ws native: unsupported WebSocketServer event "${event}"`);
    }
    this.connectionListeners.push(listener);
    return this;
  }

  /** ws's shouldHandle: false when `path` is set and the request path differs. */
  shouldHandle(request: IncomingMessage): boolean {
    const path = this.options.path;
    if (path === undefined) return true;
    const url = request.url ?? "";
    const query = url.indexOf("?");
    return (query === -1 ? url : url.slice(0, query)) === path;
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    callback: ConnectionListener,
  ): void {
    // Until setSocket takes over, a socket error just ends the attempt.
    socket.on("error", () => socket.destroy());
    const key = request.headers["sec-websocket-key"];
    const upgrade = request.headers["upgrade"];
    const version = Number(request.headers["sec-websocket-version"]);
    if (request.method !== "GET") {
      rejectUpgrade(socket, 405, "Invalid HTTP method");
      return;
    }
    if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") {
      rejectUpgrade(socket, 400, "Invalid Upgrade header");
      return;
    }
    if (key === undefined || !KEY_PATTERN.test(key)) {
      rejectUpgrade(socket, 400, "Missing or invalid Sec-WebSocket-Key header");
      return;
    }
    if (version !== 13 && version !== 8) {
      rejectUpgrade(socket, 400, "Missing or invalid Sec-WebSocket-Version header", {
        "Sec-WebSocket-Version": SUPPORTED_VERSIONS,
      });
      return;
    }
    if (!this.shouldHandle(request)) {
      rejectUpgrade(socket, 400);
      return;
    }
    let protocols = new Set<string>();
    const protocolHeader = request.headers["sec-websocket-protocol"];
    if (protocolHeader !== undefined) {
      const parsed = parseProtocols(protocolHeader);
      if (parsed === null) {
        rejectUpgrade(socket, 400, "Invalid Sec-WebSocket-Protocol header");
        return;
      }
      protocols = parsed;
    }
    const verifyClient = this.options.verifyClient;
    if (verifyClient === undefined) {
      this.completeUpgrade(key, protocols, request, socket, head, callback);
      return;
    }
    const origin = version === 8 ? request.headers["sec-websocket-origin"] : request.headers.origin;
    const info: VerifyClientInfo = {
      origin: typeof origin === "string" ? origin : undefined,
      req: request,
    };
    verifyClient(info, (verified, code, message, headers) => {
      if (!verified) {
        rejectUpgrade(socket, code ?? 401, message, headers);
        return;
      }
      this.completeUpgrade(key, protocols, request, socket, head, callback);
    });
  }

  private completeUpgrade(
    key: string,
    protocols: Set<string>,
    request: IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    callback: ConnectionListener,
  ): void {
    if (!socket.readable || !socket.writable) {
      socket.destroy();
      return;
    }
    if (this.state !== RUNNING) {
      rejectUpgrade(socket, 503);
      return;
    }
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKeyFor(key)}`,
    ];
    const ws = new WebSocket(null, undefined, {
      maxPayload: this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
    });
    if (protocols.size > 0) {
      const handleProtocols = this.options.handleProtocols;
      const first = protocols.values().next().value;
      const protocol =
        handleProtocols === undefined ? (first ?? false) : handleProtocols(protocols, request);
      if (protocol !== false) {
        lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
        ws.protocol = protocol;
      }
    }
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (this.trackClients) {
      this.clients.add(ws);
      ws.on("close", () => {
        this.clients.delete(ws);
        if (this.emitCloseWhenEmpty && this.clients.size === 0) {
          process.nextTick(() => this.emitClose());
        }
      });
    }
    ws.setSocket(socket, head);
    callback(ws, request);
  }

  private emitConnection(ws: WebSocket, request: IncomingMessage): void {
    for (const listener of this.connectionListeners.slice()) listener(ws, request);
  }

  private emitClose(): void {
    this.state = CLOSED;
    const callbacks = this.closeCallbacks;
    this.closeCallbacks = [];
    for (const callback of callbacks) callback();
  }

  /**
   * Stops accepting upgrades. As in ws 8, open sockets stay open; 'close'
   * fires once the last tracked socket has closed.
   */
  close(callback?: (error?: Error) => void): void {
    if (this.state === CLOSED) {
      if (callback !== undefined) {
        const error = new Error("The server is not running");
        this.closeCallbacks.push(() => callback(error));
      }
      process.nextTick(() => this.emitClose());
      return;
    }
    if (callback !== undefined) this.closeCallbacks.push(() => callback());
    if (this.state === CLOSING) return;
    this.state = CLOSING;
    if (this.trackClients && this.clients.size > 0) this.emitCloseWhenEmpty = true;
    else process.nextTick(() => this.emitClose());
  }
}
