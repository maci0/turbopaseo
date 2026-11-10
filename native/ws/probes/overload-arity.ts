// Typed `on` overloads whose implementation takes the listener as `unknown` and
// casts it to the event's listener type. This is the shape client.ts uses.
//
// Two other implementation types fail under scriptc 0.4.10:
// - a union of the listener types: registering `() => void` under 'close'
//   throws at run time ("a '() => void' value is not representable in the
//   target union");
// - `(...args: never[]) => void`: every call is refused (SC1090, variadic
//   function values where another signature is expected).
//
// Checks every listener arity, `off` identity, and a loose interface view.

type CloseListener = (code: number, reason: Buffer) => void;
type PingListener = (data: Buffer) => void;
type LooseListener = (...args: unknown[]) => void;

interface LooseView {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
}

class Sock {
  private closeListeners: CloseListener[] = [];
  on(event: "close", listener: CloseListener): this;
  on(event: "ping", listener: PingListener): this;
  on(event: string, listener: LooseListener): this;
  on(event: string, listener: unknown): this {
    if (event === "close") this.closeListeners.push(listener as CloseListener);
    return this;
  }
  off(event: string, listener: unknown): this {
    if (event === "close") {
      const index = this.closeListeners.indexOf(listener as CloseListener);
      if (index !== -1) this.closeListeners.splice(index, 1);
    }
    return this;
  }
  fire(): void {
    for (const l of this.closeListeners.slice()) l(1000, Buffer.from("bye"));
  }
}

const sock = new Sock();
sock.on("close", (code, reason) => console.log(`typed ${code} ${reason.toString()}`));
sock.on("close", (code: number) => console.log(`one-param ${code}`));
const variadic = (...args: unknown[]): void => console.log(`variadic ${String(args[0])}`);
sock.on("close", variadic);
const zero = (): void => console.log("zero-param");
sock.on("close", zero);
const view = sock as unknown as LooseView;
const viewListener = (...args: unknown[]): void => console.log(`view ${String(args[1])}`);
view.on?.("close", viewListener);
sock.fire();
sock.off("close", zero);
sock.off("close", variadic);
view.off?.("close", viewListener);
console.log("after off");
sock.fire();
