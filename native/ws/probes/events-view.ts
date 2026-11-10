// EventEmitter subclass viewed through a loose interface (the WebSocketLike
// pattern). Under scriptc 0.4.10 each `as unknown as View` below fails with
// SC2002 (record shapes must match exactly); in events.ts, where the view also
// names readyState and send, the cast compiles but listeners registered
// through it never run. Node prints every line.
import { EventEmitter } from "node:events";

interface OptionalOn {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}
interface RequiredOn {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}
interface MethodOn {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

class Sock extends EventEmitter {
  fire(): void {
    this.emit("message", Buffer.from("hi"), true);
  }
}

const sock = new Sock();
sock.on("message", (...args: unknown[]) => console.log(`direct variadic ${args.length}`));
sock.on("message", (data: unknown, isBinary: unknown) =>
  console.log(`direct unknown2 ${String(isBinary)} ${data instanceof Uint8Array}`),
);
const optional = sock as unknown as OptionalOn;
optional.on?.("message", (...args: unknown[]) => console.log(`optional ${args.length}`));
const required = sock as unknown as RequiredOn;
required.on("message", (...args: unknown[]) => console.log(`required ${args.length}`));
const method = sock as unknown as MethodOn;
method.on("message", (...args: unknown[]) => console.log(`method ${args.length}`));
const computed: string = process.argv.length > 100 ? "x" : "message";
sock.on(computed, (...args: unknown[]) => console.log(`computed ${args.length}`));
sock.fire();
console.log(`count ${sock.listenerCount("message")}`);
