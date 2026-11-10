// Server-side scenario behavior, shared by peer-ws.ts (real ws under Node) and
// peer-native.ts (this package, native). The client picks a behavior by path;
// the query string names the scenario so server log lines can be grouped.
// Every log line starts with "S <url>".
import type { IncomingMessage } from "node:http";
import { describeData, describeReason, pattern } from "./shared.ts";

/** The server-side socket members the scenarios use, as views see them. */
export interface ServerSocketView {
  readyState: number;
  send: (data: string | Uint8Array, options: { binary?: boolean; fin?: boolean }) => void;
  ping: (data?: string | Buffer) => void;
  close: (code?: number, reason?: string) => void;
  pause: () => void;
  resume: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

const MAX_PAYLOAD_OVERFLOW_BYTES = 2000;
const LARGE_FRAGMENT_BYTES = 100_000;
const PAUSE_MS = 100;

export function selectProtocol(protocols: Set<string>, request: IncomingMessage): string | false {
  if ((request.url ?? "").startsWith("/reject-protocol")) return false;
  const first = protocols.values().next();
  return first.done === true ? false : first.value;
}

function log(url: string, line: string): void {
  console.log(`S ${url} ${line}`);
}

export function handleConnection(ws: ServerSocketView, request: IncomingMessage, port: number): void {
  const url = request.url ?? "";
  const path = url.split("?")[0] ?? "";
  log(url, `connection`);
  ws.on("message", (...args: unknown[]) => {
    const data = args[0];
    const isBinary = args[1] === true;
    log(url, `message ${isBinary ? "binary" : "text"} ${describeData(data)}`);
    if ((path === "/echo" || path === "/pause") && (typeof data === "string" || Buffer.isBuffer(data))) {
      ws.send(data, { binary: isBinary });
    }
  });
  ws.on("pong", (...args: unknown[]) => {
    const data = args[0];
    log(url, `pong ${describeData(data)}`);
    if (Buffer.isBuffer(data)) ws.send(`pong:${data.toString()}`, {});
  });
  ws.on("close", (...args: unknown[]) => {
    log(url, `close ${String(args[0])} ${describeReason(args[1])}`);
  });
  ws.on("error", (...args: unknown[]) => {
    const error = args[0];
    log(url, `error ${error instanceof Error ? error.message : "?"}`);
  });

  if (path === "/fragments") {
    ws.send("ab", { fin: false });
    ws.send("cd", { fin: false });
    ws.send("ef", { fin: true });
    ws.send(Buffer.from([1, 2]), { binary: true, fin: false });
    ws.send(Buffer.from([3]), { binary: true, fin: true });
    const large = pattern(3 * LARGE_FRAGMENT_BYTES);
    ws.send(large.subarray(0, LARGE_FRAGMENT_BYTES), { binary: true, fin: false });
    ws.send(large.subarray(LARGE_FRAGMENT_BYTES, 2 * LARGE_FRAGMENT_BYTES), {
      binary: true,
      fin: false,
    });
    ws.send(large.subarray(2 * LARGE_FRAGMENT_BYTES), { binary: true, fin: true });
    ws.close(1000, "sent");
  } else if (path === "/ping") {
    ws.ping("hi");
  } else if (path === "/close-4002") {
    ws.close(4002, "srv");
  } else if (path === "/close-empty") {
    ws.close();
  } else if (path === "/big") {
    ws.send(pattern(MAX_PAYLOAD_OVERFLOW_BYTES), { binary: true });
  } else if (path === "/pause") {
    ws.pause();
    setTimeout(() => {
      log(url, "resume");
      ws.resume();
    }, PAUSE_MS);
  } else if (path === "/headers") {
    const test = request.headers["x-test"];
    const hostOk = request.headers.host === `127.0.0.1:${port}`;
    ws.send(`x-test=${String(test)} host-ok=${hostOk}`, {});
  }
}

/** verifyClient (two-argument form) of the small server: X-Reject gets a 403. */
export function verifySmallClient(
  info: { req: IncomingMessage },
  callback: (result: boolean, code?: number, message?: string) => void,
): void {
  if (info.req.headers["x-reject"] !== undefined) callback(false, 403, "Nope");
  else callback(true);
}

/** The small server: path "/small", maxPayload 1000, verifySmallClient. */
export function handleSmallConnection(
  ws: ServerSocketView,
  request: IncomingMessage,
  clients: number,
): void {
  const url = request.url ?? "";
  log(url, `small connection clients=${clients}`);
  ws.on("message", (...args: unknown[]) => {
    log(url, `small message ${describeData(args[0])}`);
  });
  ws.on("close", (...args: unknown[]) => {
    log(url, `small close ${String(args[0])} ${describeReason(args[1])}`);
  });
  ws.on("error", (...args: unknown[]) => {
    const error = args[0];
    log(url, `small error ${error instanceof Error ? error.message : "?"}`);
  });
}
