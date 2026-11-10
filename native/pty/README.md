# native/pty

A `forkpty` shim that replaces `node-pty` in scriptc builds of Paseo. scriptc cannot load
Node-API addons, so `pty.c` does the terminal work in plain C and `pty.ts` exposes the part
of node-pty's `IPty` that `packages/server/src/terminal/terminal.ts` uses, over scriptc's
FFI (`ffi.json`, format 6). Linux and macOS only.

| File       | Role                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `pty.c`    | spawn, write queue, resize, kill, reader and reaper threads          |
| `ffi.json` | manifest; links `./libpty.a`, `-lutil`, `-lpthread`                  |
| `pty.ts`   | `spawn(file, args, options)` returning `IPty`                        |
| `build.sh` | `clang` compiles `pty.c` to `libpty.a` beside itself                 |
| `demo.ts`  | end-to-end cases, one `name=value` line each                         |
| `test.sh`  | builds both, runs the demo under `timeout`, asserts every line       |

## Build and test

```console
$ ./build.sh
$ SCRIPTC=/path/to/scriptc ./test.sh
```

`test.sh` finds the project root by walking up to `.git` and writes the binary to
`<root>/.scratch/pty/demo` (override with `OUT_DIR`). It runs `scriptc build` from this
directory with `--node-islands=off`. Each demo case kills its child and exits 2 after
10 s; `timeout` stops the whole run after 60 s.

## How it works

`pty_spawn` copies its borrowed arguments, blocks all signals across `forkpty`, and in the
child resets every signal disposition and the mask, marks inherited fds `>= 3` close-on-exec
(`close_range` on Linux, an `fcntl` loop elsewhere), `chdir`s, swaps `environ` and calls
`execvp`. A close-on-exec pipe reports a `chdir` or `exec` failure, which `spawn` throws as
`PtySpawnError` with `strerror` text. The master is close-on-exec and non-blocking.

`pty_start` registers one retained foreign-thread callback (`invoke: "foreign"`) and starts
two detached threads per terminal:

- waiter: `waitid(WNOWAIT)`, marks the pid unusable for `kill`, then `waitpid` reaps it.
  `pty_kill` never signals a recycled pid.
- io: `poll`s the master and a wake pipe, delivers output, flushes queued input on
  `POLLOUT`, retries `EINTR`, stops reading on `EAGAIN`, treats a 0-byte read or `EIO` as
  the slave side closing. After the child exits it drains what is buffered, then delivers
  the exit event and closes the master.

Output is cut on UTF-8 sequence boundaries (up to 3 bytes carried to the next chunk), so the
`string` callback class never splits a character. Exit is the last event of a handle;
`pty.ts` calls `ptyRelease` from it, which unpins the closure and lets the event loop exit.
The native slot is freed when release, io and waiter have all finished.

Matching node-pty: `TERM` comes from `name` (default `xterm`), `PWD` is set to `cwd`, termios
flags copy node-pty's `pty.cc`, `kill()` defaults to `SIGHUP` and ignores delivery
failures, `signal` is present in the exit event only when the child was killed by one.
`args` takes node-pty's `string[] | string`; a string throws node-pty's
`args as a string is not supported on unix.`

`pty_detach_session(logPath)` (`ptyDetachSession`) is not part of node-pty. Paseo's native
terminal worker (`packages/server/src/terminal/terminal-worker-native-process.ts`) calls it
first: `setsid()`, then stderr appended to `logPath` (created `0600`). It stands in for
`spawn({ detached: true })` and an fd stdio slot, which scriptc's `fork()` lacks. `pty.ts`
declares it without calling it, because scriptc refuses a manifest entry that the program
does not declare (`SC5002`).

## Verified (Linux x86_64, glibc 2.44, clang 23, scriptc 0.4.10)

`test.sh` passes; each line below is an assertion on the demo's stdout:

- `sh -c 'printf hello; sleep 0.1; exit 3'`: output `hello`, `exitCode` 3.
- `cat`: `ping\n` comes back as `ping\r\nping\r\n` (echo plus cat), `^D` exits 0.
- 200000 bytes of input to `head -c 200000 | wc -c` all arrive (write queue and `POLLOUT`).
- `resize(132, 50)` then `stty size` prints `50 132`.
- `kill("SIGTERM")` and `kill()` give `signal` 15 and 1 within 2 s; `/proc/<pid>` is gone.
- 200000 bytes of output written just before exit all arrive before the exit event.
- 30000 `é` (2 bytes each) decode without U+FFFD.
- `sleep 5 & printf bg; exit 4`: exit 4 within 2 s although the background job holds the slave.
- The child's `SigBlk` and `SigIgn` are zero; it sees only fds 0 to 3 (3 is `ls`'s own)
  while another pty is open.
- A `node:child_process` child running at the same time keeps its own exit code (6), and the
  pty keeps its (5): the runtime does not reap pty children.
- `write`, `resize` and `kill` after exit do not throw; a missing binary or `cwd` throws
  `ENOENT`.
- 260 sequential spawns (table size 256) all exit 0 with no fd growth.
- A mutant with exit delivery removed makes the demo print `TIMEOUT hello` and exit 2.

## Used by Paseo

Native daemon builds map `node-pty` to `pty.ts` with a tsconfig `paths` entry and pass
`--ffi native/pty/ffi.json`. A probe through the daemon's terminal manager
(`startWorkerTerminalManager`: native launcher and worker, `/bin/sh`, input, resize to
`50 132`, kill, exit event, no process left) printed the same lines natively as under Node
with real node-pty, on Linux. The native probe replaced `@xterm/headless` and its addons
with a text-only stub, because scriptc cannot construct their classes.

## Not verified

- macOS: compiles only in theory; nothing here has run on Darwin. Its master may report EOF
  differently and `close_range` is absent (the `fcntl` loop is used).
- `pty_release` before exit (closes the master, the child gets `SIGHUP`): `pty.ts` never
  does this, and no test covers it.
- Thread sanitizer: scriptc's `--sanitize` is unavailable with FFI.
- macOS for `pty_detach_session`.

## Known limits

- No output backpressure: the foreign callback queue is unbounded, so a flooding child grows
  memory until the event loop catches up. node-pty does not pause by default either.
- Only `encoding: "utf8"`; there is no `Buffer` mode.
- At most 256 live terminals (`PTY_MAX_SLOTS`).
- No `uid`/`gid`, `handleFlowControl`, `pause`/`resume`, `process`, `clear` or Windows.
- The pipe and master descriptors get close-on-exec with `fcntl` after creation on macOS, so
  a fork on another thread in that window can inherit them. Linux uses `pipe2(O_CLOEXEC)`
  for the pipes but still sets it on the master afterwards.
- When someone else reaps the child (`ECHILD`) the exit event carries `exitCode` -1.
- Unlike node-pty, a `process.env` passed as `env` is not sanitized.
