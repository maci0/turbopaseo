// Client-side scenarios, shared by client-ws.ts (real ws under Node) and
// client-native.ts (this package, native). Each scenario logs "C <name> ..."
// lines; test.sh compares the logs of both clients against tests/expected/.
// Scenarios run one at a time, each bounded by SCENARIO_TIMEOUT_MS.
import { createWebSocketTransportFactory } from "../../../work/paseo/packages/client/src/daemon-client-websocket-transport.js";
import type { WebSocketLike } from "../../../work/paseo/packages/client/src/daemon-client-transport-types.js";
import type * as net from "node:net";
import { describeData, describeError, describeReason, pattern } from "./shared.ts";
import {
  clientFrame,
  closePayload,
  describeServerBytes,
  rawExchange,
  upgradeRequest,
} from "./raw-client.ts";

const SCENARIO_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 300;
const MAX_PAYLOAD_BYTES = 1000;
const BUFFERED_PAYLOAD_BYTES = 8 * 1024 * 1024;
const SIZES = [125, 126, 127, 65535, 65536, 70000, 5 * 1024 * 1024];

export interface SendOptions {
  binary?: boolean;
  fin?: boolean;
}

/** The client socket members the scenarios use, as views see them. */
export interface ClientSocketView {
  readyState: number;
  bufferedAmount: number;
  protocol: string;
  binaryType: string;
  send: (data: string | Uint8Array, options: SendOptions, cb?: (error?: Error) => void) => void;
  ping: (data?: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
}

export interface ClientTestOptions {
  headers?: Record<string, string>;
  maxPayload?: number;
  handshakeTimeout?: number;
  ca?: string;
}

// npm ws calls send callbacks with null on success and this package with
// undefined; the logs print both as "none".
/** `budgeted` builds the subclass with an overridden send, as Paseo's BudgetedWebSocket. */
export type CreateSocket = (
  url: string,
  protocols: string[] | undefined,
  options: ClientTestOptions,
  budgeted: boolean,
) => ClientSocketView;

export interface Endpoints {
  wsPort: number;
  unixPath: string;
  tlsPort: number;
  rawPort: number;
  refusedPort: number;
  smallPort: number;
  ca: string;
}

type Finish = () => void;
type Scenario = (name: string, finish: Finish) => void;

function log(name: string, line: string): void {
  console.log(`C ${name} ${line}`);
}

/** Logs every event; `onMessage` sees each message after it is logged. */
function track(
  name: string,
  socket: ClientSocketView,
  finish: Finish,
  onMessage?: (data: unknown, isBinary: boolean) => void,
): void {
  socket.on("upgrade", (...args: unknown[]) => {
    const response = args[0];
    const status =
      typeof response === "object" && response !== null && "statusCode" in response
        ? String(response.statusCode)
        : "?";
    log(name, `upgrade ${status}`);
  });
  socket.on("open", () => log(name, `open protocol=${JSON.stringify(socket.protocol)}`));
  socket.on("message", (...args: unknown[]) => {
    const isBinary = args[1] === true;
    log(name, `message ${isBinary ? "binary" : "text"} ${describeData(args[0])}`);
    onMessage?.(args[0], isBinary);
  });
  socket.on("ping", (...args: unknown[]) => log(name, `ping ${describeData(args[0])}`));
  socket.on("pong", (...args: unknown[]) => log(name, `pong ${describeData(args[0])}`));
  socket.on("error", (...args: unknown[]) => log(name, `error ${describeError(args[0])}`));
  socket.on("close", (...args: unknown[]) => {
    log(name, `close ${String(args[0])} ${describeReason(args[1])} readyState=${socket.readyState}`);
    finish();
  });
}

function caught(name: string, action: () => void): void {
  try {
    action();
    log(name, "no throw");
  } catch (error) {
    log(name, `threw ${describeError(error)}`);
  }
}

export function scenarios(create: CreateSocket, endpoints: Endpoints): Map<string, Scenario> {
  const base = `ws://127.0.0.1:${endpoints.wsPort}`;
  const raw = `ws://127.0.0.1:${endpoints.rawPort}`;
  const all = new Map<string, Scenario>();
  const open = (name: string, path: string, options: ClientTestOptions = {}): ClientSocketView =>
    create(`${base}${path}?s=${name}`, undefined, options, false);

  all.set("text", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish, () => socket.close(1000, "done"));
    socket.on("open", () => socket.send("hello", {}));
  });

  all.set("binary", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish, () => socket.close(1000));
    socket.on("open", () => socket.send(pattern(10), {}));
  });

  all.set("empty", (name, finish) => {
    const socket = open(name, "/echo");
    let received = 0;
    track(name, socket, finish, () => {
      received += 1;
      if (received === 2) socket.close();
    });
    socket.on("open", () => {
      socket.send("", {});
      socket.send(Buffer.alloc(0), {});
    });
  });

  all.set("sizes", (name, finish) => {
    const socket = open(name, "/echo");
    let received = 0;
    track(name, socket, finish, () => {
      received += 1;
      if (received === SIZES.length + 1) socket.close(1000);
    });
    socket.on("open", () => {
      for (const size of SIZES) socket.send(pattern(size), {});
      socket.send("x".repeat(126), {});
    });
  });

  all.set("buffered", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish, () => {
      log(name, `bufferedAmount at echo=${socket.bufferedAmount}`);
      socket.close(1000);
    });
    socket.on("open", () => {
      log(name, `bufferedAmount before=${socket.bufferedAmount}`);
      socket.send(pattern(BUFFERED_PAYLOAD_BYTES), {}, (error) => {
        log(name, `send callback error=${error instanceof Error ? describeError(error) : "none"}`);
      });
      log(name, `bufferedAmount>0 after send=${socket.bufferedAmount > 0}`);
    });
  });

  all.set("client-fragments", (name, finish) => {
    const socket = open(name, "/echo");
    let received = 0;
    track(name, socket, finish, () => {
      received += 1;
      if (received === 2) socket.close(1000);
    });
    socket.on("open", () => {
      socket.send("ab", { fin: false });
      socket.send("cd", { fin: false });
      socket.send("ef", { fin: true });
      socket.send(Buffer.from([1, 2]), { binary: true, fin: false });
      socket.send(Buffer.from([3, 4]), { binary: true, fin: true });
    });
  });

  all.set("server-fragments", (name, finish) => {
    track(name, open(name, "/fragments"), finish);
  });

  all.set("server-ping", (name, finish) => {
    const socket = open(name, "/ping");
    track(name, socket, finish, () => socket.close(1000));
  });

  all.set("client-ping", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => socket.ping("cp"));
    socket.on("pong", () => socket.close(1000));
  });

  all.set("server-close", (name, finish) => {
    track(name, open(name, "/close-4002"), finish);
  });

  all.set("server-close-empty", (name, finish) => {
    track(name, open(name, "/close-empty"), finish);
  });

  all.set("client-close", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => {
      socket.close(4001, "bye");
      log(name, `readyState after close()=${socket.readyState}`);
      socket.close(4001, "again");
    });
  });

  all.set("send-after-close", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => {
      socket.close(1000);
      socket.send("late", {}, (error) => {
        log(name, `send callback ${error instanceof Error ? describeError(error) : "none"}`);
      });
      log(name, `bufferedAmount after late send=${socket.bufferedAmount}`);
    });
  });

  all.set("terminate", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => {
      socket.terminate();
      log(name, `readyState after terminate()=${socket.readyState}`);
    });
  });

  all.set("close-connecting", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.close();
    log(name, `readyState after close()=${socket.readyState}`);
  });

  all.set("send-connecting", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    caught(name, () => socket.send("early", {}));
    caught(name, () => socket.ping());
    socket.terminate();
  });

  // ws enters CLOSING before it validates close()'s arguments, so after the
  // throw the socket stays CLOSING without a close frame; terminate() ends it.
  all.set("close-bad-code", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => {
      caught(name, () => socket.close(1005));
      log(name, `readyState after throw=${socket.readyState}`);
      caught(name, () => socket.close(1000));
      socket.terminate();
    });
  });

  all.set("close-long-reason", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => {
      caught(name, () => socket.close(1000, "x".repeat(124)));
      socket.terminate();
    });
  });

  all.set("ping-too-long", (name, finish) => {
    const socket = open(name, "/echo");
    track(name, socket, finish);
    socket.on("open", () => {
      caught(name, () => socket.ping("x".repeat(126)));
      socket.close(1000);
    });
  });

  all.set("refused", (name, finish) => {
    const url = `ws://127.0.0.1:${endpoints.refusedPort}/`;
    track(name, create(url, undefined, {}, false), finish);
  });

  for (const path of ["bad-accept", "status-400", "bad-upgrade"]) {
    all.set(path, (name, finish) => {
      track(name, create(`${raw}/${path}?s=${name}`, undefined, {}, false), finish);
    });
  }

  for (const path of ["invalid-utf8", "bad-opcode", "masked", "bad-close-code", "rsv1", "ping-126"]) {
    all.set(path, (name, finish) => {
      track(name, create(`${raw}/${path}?s=${name}`, undefined, {}, false), finish);
    });
  }

  all.set("handshake-timeout", (name, finish) => {
    const url = `${raw}/hang?s=${name}`;
    track(name, create(url, undefined, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS }, false), finish);
  });

  all.set("max-payload", (name, finish) => {
    track(name, open(name, "/big", { maxPayload: MAX_PAYLOAD_BYTES }), finish);
  });

  all.set("subprotocol", (name, finish) => {
    const socket = create(`${base}/echo?s=${name}`, ["chat", "superchat"], {}, false);
    track(name, socket, finish);
    socket.on("open", () => socket.close(1000));
  });

  all.set("no-subprotocol", (name, finish) => {
    track(name, create(`${base}/reject-protocol?s=${name}`, ["chat"], {}, false), finish);
  });

  all.set("headers", (name, finish) => {
    const socket = open(name, "/headers", { headers: { "X-Test": "v1" } });
    track(name, socket, finish, () => socket.close(1000));
  });

  all.set("invalid-arguments", (name, finish) => {
    caught(name, () => create("ftp://example.com/", undefined, {}, false));
    caught(name, () => create(`${base}/echo#frag`, undefined, {}, false));
    caught(name, () => create(`${base}/echo`, ["a b"], {}, false));
    caught(name, () => create(`${base}/echo`, ["a", "a"], {}, false));
    caught(name, () => create(`${base}/echo`, undefined, { headers: { "X-Bad": "a\r\nb" } }, false));
    finish();
  });

  all.set("unix", (name, finish) => {
    const socket = create(`ws+unix://${endpoints.unixPath}:/echo?s=${name}`, undefined, {}, false);
    track(name, socket, finish, () => socket.close(1000));
    socket.on("open", () => socket.send("over unix", {}));
  });

  all.set("tls", (name, finish) => {
    const url = `wss://localhost:${endpoints.tlsPort}/echo?s=${name}`;
    const socket = create(url, undefined, { ca: endpoints.ca }, false);
    track(name, socket, finish, () => socket.close(1000));
    socket.on("open", () => socket.send(pattern(70000), {}));
  });

  all.set("tls-untrusted", (name, finish) => {
    const url = `wss://localhost:${endpoints.tlsPort}/echo?s=${name}`;
    track(name, create(url, undefined, {}, false), finish);
  });

  all.set("event-target", (name, finish) => {
    const socket = open(name, "/echo");
    socket.binaryType = "arraybuffer";
    let received = 0;
    const removed = (): void => log(name, "removed listener ran");
    socket.addEventListener("message", removed);
    socket.removeEventListener("message", removed);
    socket.addEventListener("open", (event: unknown) => {
      log(name, `event open type=${eventField(event, "type")}`);
      socket.send("t", {});
      socket.send(Buffer.from([1, 2, 3]), {});
    });
    socket.addEventListener("message", (event: unknown) => {
      const data = typeof event === "object" && event !== null && "data" in event ? event.data : null;
      log(name, `event message ${describeData(data)}`);
      received += 1;
      if (received === 2) socket.close(4003, "et");
    });
    socket.addEventListener("close", (event: unknown) => {
      log(
        name,
        `event close code=${eventField(event, "code")} reason=${eventField(event, "reason")} wasClean=${eventField(event, "wasClean")}`,
      );
      finish();
    });
  });

  all.set("paseo-transport", (name, finish) => {
    const factory = createWebSocketTransportFactory(
      (url, options) =>
        create(url, options?.protocols, { headers: options?.headers }, true) as unknown as WebSocketLike,
    );
    const transport = factory({
      url: `${base}/echo?s=${name}`,
      headers: { "X-Test": "transport" },
      protocols: ["paseo"],
    });
    transport.onOpen(() => {
      log(name, `transport open supportsDrain=${String(transport.supportsDrain)}`);
      void transport.send("hello transport");
      void transport.send(Buffer.from([9, 8, 7]));
    });
    let received = 0;
    transport.onMessage((data, isBinary) => {
      log(name, `transport message isBinary=${isBinary} ${describeData(data)}`);
      received += 1;
      if (received === 2) transport.close(1000, "transport done");
    });
    transport.onError((event) => log(name, `transport error ${typeof event}`));
    transport.onClose((event) => {
      log(
        name,
        `transport close code=${eventField(event, "code")} reason=${eventField(event, "reason")}`,
      );
      finish();
    });
  });

  // Server paths a conforming client never takes, driven over raw TCP.
  const rawToServer = (
    name: string,
    finish: Finish,
    port: number,
    first: Buffer,
    onBytes: (received: Buffer, socket: net.Socket) => void = () => {},
  ): void => {
    rawExchange(port, first, onBytes, (received) => {
      log(name, describeServerBytes(received));
      finish();
    });
  };

  all.set("server-head-bytes", (name, finish) => {
    const request = upgradeRequest(`/echo?s=${name}`, []);
    let closed = false;
    rawToServer(
      name,
      finish,
      endpoints.wsPort,
      Buffer.concat([Buffer.from(request), clientFrame(0x1, Buffer.from("head"))]),
      (received, socket) => {
        if (closed || !received.includes("head")) return;
        closed = true;
        socket.write(clientFrame(0x8, closePayload(1000)));
      },
    );
  });

  all.set("server-unmasked", (name, finish) => {
    const request = upgradeRequest(`/echo?s=${name}`, []);
    const frame = clientFrame(0x1, Buffer.from("x"), false);
    rawToServer(name, finish, endpoints.wsPort, Buffer.concat([Buffer.from(request), frame]));
  });

  all.set("server-missing-key", (name, finish) => {
    const request = upgradeRequest(`/echo?s=${name}`, [], "");
    rawToServer(name, finish, endpoints.wsPort, Buffer.from(request));
  });

  all.set("server-bad-version", (name, finish) => {
    const request = upgradeRequest(`/echo?s=${name}`, []).replace(
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Version: 12",
    );
    rawToServer(name, finish, endpoints.wsPort, Buffer.from(request));
  });

  all.set("server-wrong-path", (name, finish) => {
    const request = upgradeRequest(`/other?s=${name}`, []);
    rawToServer(name, finish, endpoints.smallPort, Buffer.from(request));
  });

  const small = `ws://127.0.0.1:${endpoints.smallPort}/small`;

  all.set("server-verify-reject", (name, finish) => {
    const options = { headers: { "X-Reject": "1" } };
    track(name, create(`${small}?s=${name}`, undefined, options, false), finish);
  });

  all.set("server-max-payload", (name, finish) => {
    const socket = create(`${small}?s=${name}`, undefined, {}, false);
    track(name, socket, finish);
    socket.on("open", () => {
      socket.send(pattern(500), {});
      socket.send(pattern(2000), {});
    });
  });

  all.set("server-pause", (name, finish) => {
    const socket = open(name, "/pause");
    let received = 0;
    track(name, socket, finish, () => {
      received += 1;
      if (received === 2) socket.close(1000);
    });
    socket.on("open", () => {
      socket.send("one", {});
      socket.send("two", {});
    });
  });

  return all;
}

function eventField(event: unknown, field: "type" | "code" | "reason" | "wasClean"): string {
  if (typeof event !== "object" || event === null) return "?";
  if (field === "type" && "type" in event) return String(event.type);
  if (field === "code" && "code" in event) return String(event.code);
  if (field === "reason" && "reason" in event) return JSON.stringify(event.reason);
  if (field === "wasClean" && "wasClean" in event) return String(event.wasClean);
  return "?";
}

/** Runs every scenario (or only those named in `only`) in order, then exits. */
export async function runClientScenarios(
  create: CreateSocket,
  endpoints: Endpoints,
  only: string[],
): Promise<void> {
  for (const [name, scenario] of scenarios(create, endpoints)) {
    if (only.length > 0 && !only.includes(name)) continue;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(name, "TIMEOUT");
        resolve();
      }, SCENARIO_TIMEOUT_MS);
      scenario(name, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }
  console.log("C DONE");
  process.exit(0);
}
