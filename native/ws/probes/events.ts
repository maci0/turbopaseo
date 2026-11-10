// A class extending EventEmitter with Buffer-only payloads, a subclass
// overriding an overloaded `send`, annotated typed listeners, and listeners
// registered through a loose interface cast (the WebSocketLike pattern). It
// compiles, but natively the listeners registered through the view never run:
// Node prints "loose message ..." and "loose close ...", the binary does not.
// This is why client.ts keeps its own listener lists.
import { EventEmitter } from "node:events";

interface Like {
  readyState: number;
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
}

type SendCallback = (err?: Error) => void;
interface SendOptions {
  binary?: boolean;
}

class Sock extends EventEmitter {
  readyState = 0;
  sent: string[] = [];

  send(data: string | Uint8Array | ArrayBuffer, cb?: SendCallback): void;
  send(data: string | Uint8Array | ArrayBuffer, options: SendOptions, cb?: SendCallback): void;
  send(
    data: string | Uint8Array | ArrayBuffer,
    optionsOrCallback?: SendOptions | SendCallback,
    cb?: SendCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : cb;
    this.sent.push(typeof data === "string" ? data : `bytes:${data.byteLength}`);
    callback?.();
  }

  fire(): void {
    this.readyState = 1;
    this.emit("open");
    this.emit("message", Buffer.from("hi"), true);
    this.emit("error", new Error("boom"));
    this.emit("close", 1000, Buffer.from("bye"));
  }
}

class Budgeted extends Sock {
  bytes = 0;
  override send(data: string | Uint8Array | ArrayBuffer, cb?: SendCallback): void;
  override send(
    data: string | Uint8Array | ArrayBuffer,
    options: SendOptions,
    cb?: SendCallback,
  ): void;
  override send(
    data: string | Uint8Array | ArrayBuffer,
    optionsOrCallback?: SendOptions | SendCallback,
    cb?: SendCallback,
  ): void {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : cb;
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    this.bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    super.send(data, options ?? {}, (error) => {
      console.log(`budgeted callback error=${error === undefined ? "none" : error.message}`);
      callback?.(error);
    });
  }
}

const sock = new Budgeted();
sock.on("open", () => console.log("typed open"));
sock.on("message", (data: Buffer, isBinary: boolean) =>
  console.log(`typed message ${data.length} ${isBinary}`),
);
sock.once("close", (code: number, reason: Buffer) =>
  console.log(`typed close ${code} ${reason.toString()}`),
);
sock.on("error", (err: Error) => console.log(`typed error ${err.message}`));

const like = sock as unknown as Like;
const loose = (...args: unknown[]): void => {
  console.log(`loose message args=${args.length} binary=${String(args[1])}`);
};
like.on?.("message", loose);
like.on?.("close", (...args: unknown[]) => console.log(`loose close ${String(args[0])}`));
like.send("abc");
sock.send(Buffer.from("xyz"), { binary: true }, () => console.log("send cb"));
sock.fire();
like.off?.("message", loose);
sock.emit("message", Buffer.from("again"), false);
console.log(`sent=${sock.sent.join(",")} bytes=${sock.bytes} listeners=${sock.listenerCount("message")}`);
