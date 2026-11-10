// A listener registry of the class's own instead of an EventEmitter base:
// one `on(event: string, listener: (...args: unknown[]) => void)` method,
// reached directly and through a loose interface view (with and without
// optional members), plus a subclass. A listener with typed fixed parameters,
// such as (code: number, reason: Buffer) => void, is refused in that slot:
// SC1090 "variadic function values where another signature is expected".

type Listener = (...args: unknown[]) => void;

interface LooseView {
  readyState: number;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface RequiredView {
  readyState: number;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

class Sock {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (list === undefined) this.listeners.set(event, [listener]);
    else list.push(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (list !== undefined) {
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    }
    return this;
  }

  protected emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event);
    if (list === undefined) return;
    for (const listener of list.slice()) listener(...args);
  }

  fire(): void {
    this.readyState = 1;
    this.emit("message", Buffer.from("hi"), true);
    this.emit("close", 1000, Buffer.from("bye"));
  }
}

class Sub extends Sock {}

const sock = new Sub();
sock.on("message", (...args: unknown[]) => {
  const data = args[0];
  console.log(`direct ${Buffer.isBuffer(data) ? data.toString() : "?"} ${String(args[1])}`);
});
const loose: LooseView = sock;
const looseListener = (...args: unknown[]): void => console.log(`loose ${String(args[1])}`);
loose.on?.("message", looseListener);
const required: RequiredView = sock;
required.once("close", (...args: unknown[]) => console.log(`required once close ${String(args[0])}`));
sock.fire();
loose.off?.("message", looseListener);
sock.fire();
console.log(`readyState via view ${loose.readyState}`);
