# native/pino

A typed stand-in for npm `pino` 10.3.1 and `pino-pretty` 13.1.3 in scriptc builds of Paseo.
It implements the part of pino Paseo's server uses and writes the same JSON lines (and the
same pino-pretty lines); Node builds keep the real packages.

| File | Role |
| --- | --- |
| `index.ts` | replaces `pino`: `pino()`, `pino.destination()`, the logger, the `Logger` type |
| `pretty.ts` | replaces `pino-pretty`: the default export with the options `logger.ts` passes |
| `test.sh` | builds `tests/log-probe.ts` natively and compares it with Node and real pino |
| `tests/` | the probe (drives Paseo's real `src/server/logger.ts`) and the line comparer |
| `probes/pipe-blocking.ts` | shows that a native write blocks when stdout's reader stalls |

`node_modules` is a symlink to `work/paseo/node_modules` (for `@types/node` and `tsc`); it is
gitignored. Create it with `ln -s ../../work/paseo/node_modules native/pino/node_modules`.
`package.json` only sets `"type": "module"`, so a default import of this module is its
default export under `module: NodeNext`.

## Why not real pino

Real pino was built natively with scriptc 0.4.10 (`scriptc build ... --optimization dev
--node-islands=off`), patching each failure in local copies (tsconfig `paths` to patched
files, or a `node_modules` directory inside the probe directory), until the first log call:

| Where | Failure |
| --- | --- |
| `atomic-sleep/index.js` | conditional `module.exports` (found earlier); replaced by an unconditional copy |
| `thread-stream/index.js:42` (required by `pino/lib/transport.js:10` at load) | `Uncaught Error: constructing FinalizationRegistry through a stored value is not supported yet [SC2020]` |
| `safe-stable-stringify/index.js:16` | `export members attached before a 'module.exports =' assignment ... is not supported yet [SC1090]` |
| `safe-stable-stringify/index.js:49` | `Object.getPrototypeOf on this value is not supported yet [SC2020]` (the TypedArray `Symbol.toStringTag` getter) |
| `pino/pino.js:87`, `:228`, `:229` | `module namespace objects as values (access 'stdSerializers' / 'time' / 'symbols' members directly) are not supported yet [SC1090]` |
| `pino/lib/caller.js:9` | `assignment to non-variables are not supported yet [SC1090]` (`Error.prepareStackTrace`) |
| `pino/lib/tools.js:268` | `TypeError: Cannot read properties of undefined (reading 'prototype')` (`stream.constructor.prototype` of a SonicBoom) |
| `on-exit-leak-free/index.js:25`, `:76` | `computed process event names currently support the SIG signal family`, then `'new WeakRef' ... has no scriptc lowering yet [SC2020]` |
| `pino/pino.js:119` | `the reference to 'configure' (a binding form with no lowering) is not supported yet [SC1090]` |
| `pino/lib/levels.js:98` | `TypeError: scriptc: Object.prototype reflection and mutation are not supported yet [SC1090]`: `this.emit` on a logger whose prototype chain pino builds with `Object.setPrototypeOf(instance, Object.create(prototype))` over `EventEmitter.prototype` |
| `pino/lib/proto.js:233` | `TypeError: expected number at $[3], got string` in the `asJson(obj, msg, num, t)` call |

The build also warns that `sonic-boom/index.js:565,643,662` (`writeSync` of `string & Buffer`
or `any` data) and `pino/lib/transport.js:273` (`require.resolve` over a run-time base) have no
lowering and throw when they run. After eleven patches in five packages no line was logged,
and what remains is pino's core design: loggers are plain objects with Symbol-keyed state on
run-time prototype chains, and `child()` is `Object.create(this)`, which scriptc documents as
unsupported (llms.txt, "Prototypes": prototype storage on objects that are not program class
prototypes). Redaction (`@pinojs/redact`) was never reached.

## Surface

Inventory of `packages/server` (`src` and `scripts`, without `*.test.ts`; no other package
imports pino):

- Imports: `import type { Logger } from "pino"` (77 files), `import type pino from "pino"`
  for `pino.Logger` (52), `import pino from "pino"` (21: `src/server/logger.ts`,
  `speech/providers/local/worker-process.ts`, the rest test utilities, fixtures and
  scripts), `import pretty from "pino-pretty"` (`logger.ts`). No other pino type is imported.
- Construction: `logger.ts` calls `pino({ level, redact: { paths: REDACT_PATHS, remove: true } },
  stream)`, where `stream` is `pino.destination({ dest: path | 1, sync: false })` or
  `pretty({ colorize: true, singleLine: true, ignore: "pid,hostname", destination: path | 1 })`,
  then `.child({ daemonVersion })`. `worker-process.ts` calls `pino({ level }).child(...)`.
  No serializers, formatters, timestamp, base, mixin, transports, multistream or custom levels.
- Logger members: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (as `(obj, msg)`,
  `(msg)`; no call with an `Error` first argument was found, but it is handled),
  `child(bindings)` without options, and `isLevelEnabled` (`session.ts`). No reads or writes of `logger.level`, no `flush`, `bindings` or `on`.
- Output path: the daemon worker passes `file: false`, so it logs JSON to fd 1; the
  supervisor (`scripts/supervisor.ts`) copies the worker's stdout and stderr chunks to its own
  streams and to `daemon.log` with its own rotation, and writes its lifecycle lines itself. The
  supervisor does not use pino.

This module implements exactly that, and matches pino on: field order (`level`, `time`, `pid`,
`hostname`, bindings in child order, then the object's own keys, then `msg`), duplicate keys
(a field that repeats a binding is written twice, as pino does), level numbers and filtering,
`silent`, the unknown level error, an `Error` as first argument, `err` (and an `err` binding)
through pino-std-serializers' `err` (type, message and stack with causes, aggregate errors,
extra enumerable fields), other errors as `JSON.stringify` writes them (`"error":{}`),
non-finite numbers as `null`, `toJSON`, safe-stable-stringify's fallback for circular values
and bigints, quick-format-unescaped's `%s %d %i %f %j %o %O %%`, redaction with
`remove: true` of top-level, nested and bracketed paths in fields and bindings, and the
`fatal` flush. `pretty.ts` parses each line and formats it as pino-pretty does for Paseo's
options: local `[HH:MM:ss.l]`, colored level label, `(name)`, cyan message, the remaining
fields as gray single-line JSON, and `err`/`error` fields as indented blocks with the stack
unfolded.

Writes are buffered like sonic-boom with `sync: false`: one `fs.write` in flight, later lines
appended, partial writes continued, `EAGAIN`/`EBUSY` retried after 100 ms, `EPIPE` turning the
destination into a no-op, other write errors thrown; pending lines are written synchronously
on `process.on("exit")` and after `fatal`.

## Selecting it

Native builds add to `compilerOptions.paths` of the scriptc entry's tsconfig:

```json
"@server/*": ["<server>/src/*"],
"pino": ["<root>/native/pino/index.ts"],
"pino-pretty": ["<root>/native/pino/pretty.ts"]
```

A `paths` entry replaces the inherited `paths` object, so the server's own `"@server/*"`
mapping (from `tsconfig.server.json`) must be repeated. The mapping also redirects
type-only imports. Checked: `tsc -p` over the server's `include` and `exclude` lists
(`src/server`, `src/services`, `src/terminal`, no tests) with these three entries reports no
errors. A frontend build of `src/server/daemon-worker.ts` (`--emit=ir`, with the `ws`,
`@hono/node-server` and agent SDK stand-ins the fix wave uses) reports no error in `logger.ts`,
in this module, or naming `Logger`; an earlier build with npm pino reported SC2002 and SC2004
at `logger.ts:180` and `:189` (the `pretty()` options record).

## Test

```console
$ ./test.sh
.../native-json-stdout.txt: 35 lines, 35 expected, 0 differing
.../native-json-file.txt: 2 lines, 2 expected, 0 differing
.../native-json-file.log: 33 lines, 33 expected, 0 differing
.../native-pretty-stdout.txt: 120 lines, 120 expected, 0 differing
.../native-pretty-file.txt: 2 lines, 2 expected, 0 differing
.../native-pretty-file.log: 118 lines, 118 expected, 0 differing
PASS
```

`test.sh` copies `tests/log-probe.ts` into a temporary `work/paseo/packages/server/zzprobe-pino-test/`
(removed on exit), builds it with `scriptc build --optimization dev --node-islands=off` into
`<root>/.scratch/nativepino` (`OUT_DIR` and `SCRIPTC` override), and runs it natively and
under Node (`tsx`, with the server's tsconfig so `pino` resolves to npm pino) in four modes:
JSON or pretty, to stdout or to a file through Paseo's `createRootLogger`. The probe logs every
level through `createChildLogger` and a child with bindings, `Error`s in each position (`err`,
first argument, `error`, an `err` binding, a string `err`, an error-like plain object),
subclasses with and without `name`, `cause` given to the constructor, assigned, and as a
function, an `AggregateError`,
every redaction path `logger.ts` configures in fields and in bindings, a 300-character message
with quotes, a backslash, a tab, a newline and non-ASCII text, every format directive and an
unknown one, an object as the message, `Date`,
`undefined`, circular and bigint values, keys that shadow `level`, `time` and `pid`, duplicate
binding keys, an empty message, a number and `null` as the message, `isLevelEnabled` answers,
the unknown level error, a `worker-process.ts` style `pino({ level }).child(...)` logger, an
upper-case level, a `silent` logger, and `fatal` last.
`tests/compare.ts` compares the outputs line by line after replacing the values of `time`,
`pid` and `hostname`, pino-pretty's time prefix and stack frames (`    at ...`), which differ
between Node and the native binary; every other byte must match (swapping two fields in one
native capture by hand made it report 25 differing lines of 26).

## Differences from pino

- Native writes block. `probes/pipe-blocking.ts` logs 5000 lines into a pipe whose reader
  sleeps 2 s, then ticks every 100 ms: under Node the ticks continue (pino's `fs.write` runs on
  the thread pool); natively the first tick comes at 2001 ms. scriptc runs `fs.write` and
  `process.stdout.write` on the main thread (llms.txt: process output writes are
  synchronous), so a daemon worker whose supervisor stops draining its stdout pipe stalls once
  the pipe buffer is full. `EPIPE` behaves as in pino: both keep running and drop the output.
- A file destination is opened with `openSync(path, "a")` when it is created; sonic-boom opens
  it asynchronously and reports a failure as an `'error'` event.
- Not implemented (Paseo does not use them): serializers other than `err`, formatters,
  `timestamp`, `base`, `mixin`, `msgPrefix`, `nestedKey`, custom levels, `child` options,
  `logger.level`, `bindings()`, `flush()`, `on()`, transports, multistream, `pino.levels`,
  `pino.stdSerializers`, wildcard redaction paths and redaction with a censor (both throw when
  the logger is created), pino's `req`/`res` mapping of a first argument that looks like an
  HTTP request or response, and every pino-pretty option other than the four `logger.ts`
  passes (the types require exactly those values).
- Objects are walked with `Object.keys`, where pino and pino-std-serializers use `for...in`:
  inherited enumerable fields of a logged object or an error are not written. A redacted
  nested object is cloned as a plain object, so a `toJSON` or getter on its prototype is not
  applied (`@pinojs/redact` keeps the prototype). The circular and bigint fallback sorts a typed
  array's index keys as strings, where safe-stable-stringify writes them in index order.
- `pretty.ts` does not reproduce secure-json-parse's handling of `__proto__` and
  `constructor.prototype` keys, nor pino-pretty's `ignore` of nested (dotted) keys.

## Unverified

- The daemon itself has not been run with this module; only the probe above and `tsc`.
- `EAGAIN`/`EBUSY` retries and the `Atomics.wait` in the exit flush were not exercised
  (`Atomics.wait` itself returns after the timeout natively, measured 50 ms for 50 ms).
- Local time in `pretty.ts` was compared with Node only in this machine's time zone.
