// node-pty replacement for scriptc builds, on the C shim in pty.c.
// Covers the IPty surface Paseo's terminal.ts uses: spawn, onData, onExit,
// write, resize, kill, pid. POSIX only.

declare function ptySpawn(
  file: string,
  argv: string,
  env: string,
  cwd: string,
  cols: number,
  rows: number,
): number;
declare function ptyStart(
  handle: number,
  onEvent: (kind: number, code: number, signal: number, data: string) => void,
): number;
declare function ptyRelease(
  handle: number,
  onEvent: (kind: number, code: number, signal: number, data: string) => void,
): void;
declare function ptyWrite(handle: number, data: string): number;
declare function ptyResize(handle: number, cols: number, rows: number): number;
declare function ptyKill(handle: number, signal: number): number;
declare function ptyPid(handle: number): number;
declare function ptySignalNumber(name: string): number;
declare function ptyStrerror(code: number, out: Uint8Array): number;
// Not called here. Paseo's native terminal worker declares and calls it
// (terminal-worker-native-process.ts); this declaration keeps the manifest
// resolvable in programs that use only `spawn`.
declare function ptyDetachSession(logPath: string): number;

const EVENT_DATA = 0;
const EVENT_EXIT = 1;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_NAME = "xterm";
const DEFAULT_KILL_SIGNAL = "SIGHUP";
const MAX_WINSIZE = 0xffff;
const STRERROR_BUFFER_BYTES = 256;

export interface IDisposable {
  dispose(): void;
}

export interface IExitEvent {
  exitCode: number;
  signal?: number;
}

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  encoding?: "utf8";
}

export interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: IExitEvent) => void): IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export class PtySpawnError extends Error {
  constructor(
    public readonly file: string,
    public readonly errno: number,
  ) {
    super(`pty spawn ${file} failed: ${describeErrno(errno)}`);
    this.name = "PtySpawnError";
  }
}

function describeErrno(errno: number): string {
  const out = new Uint8Array(STRERROR_BUFFER_BYTES);
  const len = ptyStrerror(errno, out);
  return `${Buffer.from(out.subarray(0, len)).toString("utf8")} (errno ${errno})`;
}

function nulList(entries: string[], what: string): string {
  let blob = "";
  for (const entry of entries) {
    if (entry.includes("\0")) {
      throw new TypeError(`pty ${what} entry contains a NUL byte`);
    }
    blob += `${entry}\0`;
  }
  return blob;
}

function checkSize(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_WINSIZE) {
    throw new RangeError(`pty ${what} must be an integer in 1..${MAX_WINSIZE}, got ${value}`);
  }
}

class Emitter<T> {
  private listeners: Array<(value: T) => void> = [];

  add(listener: (value: T) => void): IDisposable {
    this.listeners.push(listener);
    const listeners = this.listeners;
    return {
      dispose(): void {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
  }

  fire(value: T): void {
    for (const listener of this.listeners.slice()) listener(value);
  }
}

class UnixPty implements IPty {
  readonly pid: number;
  private currentCols: number;
  private currentRows: number;
  private exited = false;
  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<IExitEvent>();
  private readonly handle: number;
  private readonly onEvent: (kind: number, code: number, signal: number, data: string) => void;

  constructor(handle: number, cols: number, rows: number) {
    this.handle = handle;
    this.currentCols = cols;
    this.currentRows = rows;
    this.pid = ptyPid(handle);
    this.onEvent = (kind: number, code: number, signal: number, data: string): void => {
      if (kind === EVENT_DATA) {
        this.dataEmitter.fire(data);
        return;
      }
      if (kind === EVENT_EXIT) {
        this.exited = true;
        // Exit is the handle's last event; the native slot is freed here.
        ptyRelease(this.handle, this.onEvent);
        this.exitEmitter.fire(signal > 0 ? { exitCode: code, signal } : { exitCode: code });
      }
    };
    const rc = ptyStart(handle, this.onEvent);
    if (rc < 0) {
      ptyKill(handle, ptySignalNumber("SIGKILL"));
      ptyRelease(handle, this.onEvent);
      throw new Error(`pty start failed: ${describeErrno(-rc)}`);
    }
  }

  get cols(): number {
    return this.currentCols;
  }

  get rows(): number {
    return this.currentRows;
  }

  onData(listener: (data: string) => void): IDisposable {
    return this.dataEmitter.add(listener);
  }

  onExit(listener: (event: IExitEvent) => void): IDisposable {
    return this.exitEmitter.add(listener);
  }

  // Input after exit is dropped, as node-pty's write stream drops it once the
  // fd is gone.
  write(data: string): void {
    if (this.exited) return;
    ptyWrite(this.handle, data);
  }

  resize(cols: number, rows: number): void {
    checkSize(cols, "cols");
    checkSize(rows, "rows");
    if (this.exited) return;
    const rc = ptyResize(this.handle, cols, rows);
    if (rc < 0) throw new Error(`pty resize failed: ${describeErrno(-rc)}`);
    this.currentCols = cols;
    this.currentRows = rows;
  }

  // Like node-pty, delivery failures (already exited, ESRCH) are ignored;
  // an unknown signal name throws.
  kill(signal: string = DEFAULT_KILL_SIGNAL): void {
    const number = ptySignalNumber(signal);
    if (number < 0) throw new TypeError(`Unknown signal: ${signal}`);
    if (this.exited) return;
    ptyKill(this.handle, number);
  }
}

// `args` takes node-pty's type; the string form is its Windows command line, refused on
// POSIX with node-pty's message.
export function spawn(file: string, args: string[] | string, options: IPtyForkOptions = {}): IPty {
  if (typeof args === "string") {
    throw new Error("args as a string is not supported on unix.");
  }
  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  checkSize(cols, "cols");
  checkSize(rows, "rows");
  const cwd = options.cwd ?? process.cwd();
  const source = options.env ?? process.env;
  const env: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.PWD = cwd;
  env.TERM = options.name ?? env.TERM ?? DEFAULT_NAME;

  const envEntries = Object.keys(env).map((key) => `${key}=${env[key]}`);
  const handle = ptySpawn(
    file,
    nulList([file, ...args], "argv"),
    nulList(envEntries, "env"),
    cwd,
    cols,
    rows,
  );
  if (handle < 0) throw new PtySpawnError(file, -handle);
  return new UnixPty(handle, cols, rows);
}
