# turbopaseo

![turbopaseo](docs/logo.png)

Native builds of [Paseo](https://github.com/getpaseo/paseo) v0.15.4, compiled with [scriptc](https://scriptc.dev/) 0.4.10.

Two git submodules: `paseo/` is upstream Paseo pinned to tag `v0.15.4`, kept pristine; `work/paseo/` is the working tree, branch `turbopaseo` of [maci0/paseo](https://github.com/maci0/paseo/tree/turbopaseo): that tag plus the source edits scriptc needs, where npm and scriptc run. The same edits are kept as `patches/paseo/source.patch`. This repo adds those patches, the `node_modules` patches, the native stand-ins, a Makefile for every executable target, and the build docs. Paseo's own patches stay in `paseo/patches`.

```
paseo/          submodule: upstream Paseo, tag v0.15.4
patches/        patches this repo applies: paseo/ to Paseo source, the rest to node_modules
work/paseo/     submodule: maci0/paseo branch turbopaseo, the patched tree where npm and scriptc run
native/         stand-ins for packages that cannot run natively, and the native entries
dist/           make dist: relocatable CLI and daemon with their runtime files (gitignored)
builds/         native outputs (gitignored)
Makefile        host build and cross targets
```

## Build the host binary

scriptc 0.4.10, Node 24 or newer, and clang. Cross targets also need zig and the matching `@scriptc/runtime-*` pack.

```
make paseo-deps
make paseo-check   # the patched tree still typechecks, builds and runs under Node
make
```

`make` writes `builds/paseo-<host>`, for example `builds/paseo-linux-x64` on x86-64 Linux. `NODE_ISLANDS=off` is the default, so a package that scriptc cannot lower fails the build.

```
make list            # linux and darwin, x86_64 and aarch64
make linux-arm64     # one cross target
make all             # those four
make help
```

The four targets and the runtime packs they need are in [docs/targets.md](docs/targets.md).

## Status

Updated 2026-11-10 (evening). "IR" means scriptc's frontend accepts the program (`scriptc build --emit=ir`, typecheck plus lowering). "Binary" means it also went through LLVM and linked. "Runs" means the native binary was executed.

| Piece | IR | Binary | Runs | Notes |
| --- | --- | --- | --- | --- |
| Base version | n/a | n/a | n/a | Rebased from v0.15.3 to v0.15.4 on 2026-11-10 (4 upstream commits: version bumps and four Claude provider files; no dependency changes; the only overlap with our edits, `packages/server/package.json`, merged cleanly). Every result below was measured on v0.15.3 unless it says otherwise; `make paseo-check` and the CLI comparisons have not been rerun on v0.15.4 yet, because the server source is mid-edit. `patches/paseo/source.patch` is also behind the work tree for the same reason. |
| Patched tree as normal Paseo under Node | n/a | n/a | yes | `make paseo-check`: `typecheck:server`, `build:server`, JS CLI `--help` and `--version` |
| Daemon supervisor (`packages/server/scripts/supervisor-entrypoint.ts`) | yes | yes | yes | Part of `builds/paseo-daemon-linux-x64` (`make daemon`, dev build 7 to 13 min, about 890 MB). Starts natively and forks the native worker over IPC. |
| Daemon worker (`packages/server/src/server/daemon-worker.ts`, the actual daemon) | yes | yes | yes | Starts natively, loads all 13 built-in plugins, and serves the CLI (rows below). Verified in an isolated home on its own port, with no agent CLIs on `PATH`, no connection to the host daemon and the host's `~/.paseo` unchanged. Known gaps: on stop the worker logs `agentManager.flushForShutdown is not a function` and exits with code 1 (cause not found yet); agent providers were not run. |
| Supervisor under Node | n/a | n/a | tests pass | Upstream behaviour restored (fork with IPC, readiness, heartbeat, restart). `supervisor.readiness`, `terminal-cleanup` and `logging` tests failed on the earlier rewrite and pass now. Log rotation is dependency-free and matches `rotating-file-stream` 3.2.9 in names, sizes and history. |
| `ws` (patched), module load | yes | yes | yes | Loads at startup in the CLI binary. |
| WebSocket client (`native/ws/client.ts`, in place of `ws`) | yes | yes | yes | Selected by the `paths` entry in `native/entries/cli/tsconfig.json`. `native/ws/test.sh`: 48 scenarios identical to real `ws` in all four client/server pairings. Used by the CLI runs above. No compression, redirects, proxy agent or URL credentials. |
| WebSocket server (`native/ws/server.ts`) | yes | yes | yes | Same test suite; attaches to an `http.Server` through the `upgrade` event, which scriptc supports. Not used by any Paseo build yet (daemon only). |
| `ajv` (patched) | yes | not built | no | |
| `@getpaseo/server/daemon-control` | not rechecked | yes | no | linked once on 2026-11-10 as a probe |
| `@getpaseo/client`: websocket transport, relay E2EE transport, ssh tunnel, buffering, `hosts` | yes | not built | no | |
| `@getpaseo/client`: `DaemonClient` class | yes | not built | no | 4 minutes of frontend time on its own |
| `@getpaseo/client/node` (`createHostClient`) | yes | yes | no | Compiles from `dist` after the source patch. |
| CLI (`make`, entry `native/entries/cli/index.ts`) | yes | yes | yes | `builds/paseo-linux-x64`. `OPTIMIZATION=release`: 21 min, 208 MB, and the 22 no-daemon commands below pass on it. `OPTIMIZATION=dev`: about 2 min 15 s, 411 MB with debug info. |
| CLI commands without a daemon | n/a | n/a | yes | 22 of 22 identical to the Node CLI in stdout, stderr and exit code: `--version`, `--help`, 14 subcommand help screens, unknown commands, `daemon status`, and `ls` with no daemon running. |
| CLI commands against a running Node daemon | n/a | n/a | yes | 17 of 17 identical to the Node CLI against an isolated daemon (own home, port 47130): `ls` variants, `daemon status`, `provider ls`, `workspace ls`, `project ls`, `schedule ls`, `terminal ls`, `host ls`, `heartbeat ls`, `worktree ls`, `plugin ls`, `inspect` and `logs` of a missing agent. `daemon status` can differ between two runs by a time-dependent field. Rechecked on the release binary. |
| CLI state-changing commands against a running Node daemon | n/a | n/a | yes | Same results as the Node CLI for one scenario: `workspace create`, `terminal create`, `terminal send-keys`, `terminal capture` (the typed marker comes back), `terminal kill`, `workspace archive`. Found and fixed a native crash in the generated message validators (issue paths that mix names and indexes). Not tested: `run`, `send`, `attach` and anything else that needs an agent provider (they would spend provider credits), relay and SSH targets, hub commands. |
| Native CLI against the native daemon | n/a | n/a | yes | `daemon status`, `ls`, `provider ls`, `workspace ls`, `terminal ls`: exit 0. State-changing: `workspace create`, `terminal create`, `terminal send-keys`, `terminal capture` (shows the typed command's output), `terminal kill`, `workspace archive` all succeed. Not compared line by line with the Node CLI yet. Known gap: `paseo daemon config set` fails natively (the CLI compiles the server from its dist JavaScript, where the config walk is untyped). |
| Terminals (`node-pty` replacement) | yes | yes | yes | `native/pty/`: `forkpty` C shim through scriptc FFI with node-pty's `spawn` members. `native/pty/test.sh` passes on Linux (spawn, output, input, resize, kill, reaping, spawn errors). Not wired into Paseo. macOS unverified. |
| Cross targets (`linux-arm64`, `darwin-x64`, `darwin-arm64`) | no | no | no | not attempted; need the runtime packs and zig |
| Daemon runtime files (skills, builtin plugins, ONNX voice asset, shell integration, OpenCode bridge, ICU data) | n/a | n/a | yes | `make dist` puts them beside the binaries in `dist/paseo-<host>/`; a native binary finds them next to `process.execPath`. A copy run from `~/.cache` with `work/`, `native/` and `builds/` hidden in a mount namespace starts its daemon through `paseo daemon start`, answers `daemon status`, `ls` and `provider ls`, and loads all 13 built-in plugins. |
| Benchmarks | n/a | n/a | no | nothing to measure yet |

### Native stand-ins

Some dependencies cannot run under scriptc at all. Each needs an implementation used only in native builds, while Node builds keep the original package. Node-only packages stay out of the native program by loading them through `createRequire` when `process.argv[0] !== "scriptc"` (the pattern in `packages/server/src/server/network/index.ts`).

| Dependency | Why it cannot run natively | Stand-in | State |
| --- | --- | --- | --- |
| `node-pty` | Node-API addon | `native/pty/`: `forkpty` C shim through FFI, selected with `paths` | Wired into the daemon's terminal code. A native probe drives Paseo's real terminal manager (launch the worker, start a shell, type, resize, kill, clean up) with output identical to Node with real node-pty. The native worker is started by re-executing the binary and detaching (`setsid`). macOS unverified. |
| `@xterm/headless`, `@xterm/addon-serialize`, `@xterm/addon-unicode-graphemes` | the npm packages ship only webpack bundles, which scriptc does not compile, with ambient typings | `native/xterm/`: the real xterm.js TypeScript sources at the commits the packages were built from (63 files; the 47 headless sources were checked byte-identical to the upstream commit), with `local.patch` over 35 of them; selected with `paths` | `native/xterm/test.sh`: 20 recorded byte streams (wrapping, colours, cursor movement, scroll regions, alternate screen, wide and combining characters, resizes, real `ls --color`, `top`, `vim`) through Paseo's own headless terminal, serializer and capture code give identical replay and capture output natively and under Node with the npm packages; one real shell session through the pty stand-in matches too. Slower natively in one unprofiled run (about 2x on the heaviest case). Not yet run inside a native daemon. |
| `uuid` | throws at load natively | `native/uuid/`: `v4` on `crypto.randomUUID()`, the only function Paseo uses | native probe passes |
| `pino`, `pino-pretty` | builds every logger on run-time prototype chains (`Object.create(this)` for `child()`), `FinalizationRegistry`, `WeakRef`; eleven patches in five packages did not get it to log one line | `native/pino/`: the surface Paseo uses (level methods, `child`, `isLevelEnabled`, `remove: true` redaction, file and stdout destinations, the four pretty options), selected with `paths` | `native/pino/test.sh`: Paseo's real `logger.ts` built natively writes the same lines as Node with real pino in JSON and pretty mode, to stdout and to a file (0 differing lines in six captures; `time`, `pid`, `hostname` values and stack frames ignored). Native limit: log writes block the event loop, so a daemon whose log pipe is not drained stalls once the pipe is full. Not yet run inside a native daemon. |
| `sherpa-onnx-node` | Node-API addon | `native/sherpa/`: C++ shim over sherpa-onnx's C API through FFI (`sherpa-onnx-ffi.ts` has the addon's class and method names), linked dynamically | Wired into Paseo's speech code through a loader hook and a native speech worker entry. `native/sherpa/proof/run.sh` drives Paseo's real worker client and worker natively and under Node: speech to text, voice activity detection and dictation give identical output; text to speech runs natively with plausible length and sample rate but cannot be compared byte for byte, because no engine repeats its output even under Node. Tested with one STT model (Parakeet 110m) and three TTS voices; whisper, sense_voice, dolphin and nemo_ctc are unrun. Ships beside the binary: `lib/libsherpa-onnx-c-api.so`, `lib/libonnxruntime.so`, `assets/silero_vad.onnx`. linux-x64 only. Not yet run inside a native daemon. |
| `ws` | client handshake needs `http.request` with `createConnection` and the client `upgrade` event | `native/ws/`: client and server on `node:net`/`node:tls`, selected with a tsconfig `paths` entry | test suite passes; client in use by the native CLI |
| `express` | swaps prototypes on every request; long tail in `depd`, `debug`, `body-parser` | `native/express/`: the subset Paseo uses, on `node:http` | wired into the server through `paths` and a small adapter (`express-node-http.ts`); one version of each Paseo file serves both. `native/express/test.sh`: 110 cases across real express, the module under Node and the native binary. A 37-case comparison of Paseo's own HTTP layer (API, auth, web UI, service proxy, streamed download, MCP `initialize`) matches natively. Differences from express are in its README (no Range, no `X-Powered-By`, no nested query syntax). No backpressure on native responses. Not yet run inside a native daemon. |
| `ajv` | builds validators with `new Function` | `packages/server/src/server/agent/json-schema-validator.ts`: interpreting draft-07 validator; Node keeps ajv | 59 tests compare it with ajv (same errors, same order on the corpus); the official JSON-Schema-Test-Suite was not run |
| `@anthropic-ai/claude-agent-sdk` | bundle hits 28 internal compiler errors (`SC9001`) | `native/claude-sdk/`: `query` and `forkSession` ported from the SDK, driving the `claude` CLI over its stdio control protocol; re-exports the SDK's types | `native/claude-sdk/test.sh`: 32 query scenarios and 19 `forkSession` cases give identical output through the real SDK under Node, the stand-in under Node and the stand-in built natively, all against a fake CLI. Never run against the real `claude` CLI (that would spend credentials). Not ported: `sessionStore` in `query()`, in-process SDK MCP servers, telemetry. Paseo's Claude provider files still need their own fixes. |
| `undici` | scriptc substitutes its own copy, which does not build in 0.4.10 | none: native builds use the runtime's `fetch` | `HTTP_PROXY`/`HTTPS_PROXY` are ignored natively |
| `https-proxy-agent` | extends the built-in `http.Agent`, which scriptc refuses | `native/https-proxy-agent/`: constructing the agent throws "not supported in the native build" | WebSocket connections through an HTTPS proxy are unavailable natively; a native probe confirms the error. |
| `openai` | its `APIPromise` extends `Promise`, which scriptc restricts | `native/openai/`: a `fetch` client for the two audio endpoints Paseo calls (transcription and speech), with the SDK's base URL and headers, retry rules, timeout and error message format | matches the real SDK against a fake HTTP server on 127.0.0.1 (multipart fields, a retry after 503, the 401 message). Never called against the real API. |
| `@codemirror/language` (under `@getpaseo/highlight`) | scriptc crashes with internal compiler errors (`SC9001`) on module-level facets and effects in `@codemirror/language` and `@codemirror/view` | `native/highlight/language.ts` replaces `@codemirror/language` with the parts highlighting needs (`Language`, `LRLanguage`, a port of the stream parser for Swift and Dart); the Lezer parsers and Paseo's own highlight source are used as they are, with small patches to `@lezer/lr` and `@codemirror/legacy-modes` | `native/highlight/test.sh`: tokens for 30 samples covering all 24 parsers are identical natively and under Node; the server's real diff highlighter gives byte-identical output on a test repository, and the native payload passes the protocol's schema. Performance not measured. Not yet run inside a native daemon. |
| `p-limit` | results that are not plain JSON (class instances, `Stats`, `Dirent[]`) cannot cross its untyped JS (`SC1101`) | `packages/server/src/utils/concurrency-limit.ts`, used in place of p-limit where tasks return such values | in the source patch; Node uses it too |
| Plugins (user-installed and built-in) | compiled at run time with esbuild and the TypeScript compiler in a worker thread, then loaded with `eval`; a native binary has no JavaScript engine | none for user-installed plugins: the native daemon starts, and compiling or loading a plugin fails with "Plugins need the Node.js daemon". For the 13 built-in plugins (usage sources, the muse, hoplite and antigravity providers, `.worktreeinclude` copying), compiling them into the binary through a static registry is in progress | the native error path is built and run. Until the static registry lands, a native daemon has none of the built-ins. Running plugins in a separate `node` process would need Node, the server's `dist` and its `node_modules` beside the binary, plus a new transport; not built. |
| Recursive file watching | `fs.watch` with `recursive` has no lowering | none needed on Linux: the Linux backend uses per-directory watches, which work natively and report the same events as Node in a native probe | on macOS and Windows a native build would fall back to polling; never run there |
| `tree-kill` | uses `child_process.spawn` as a value | none yet | native force-kill signals only the direct child |
| `@hono/node-server` 1.x (used by the MCP SDK) | scriptc has a built-in implementation for 2.x only; Paseo installs 1.19.14 | a tsconfig `paths` entry mapping `@hono/node-server` to scriptc's own `declarations/shims/hono-node-server/v2.ts`; Node keeps 1.19.14 and `package.json` is unchanged | the MCP SDK's `server/streamableHttp.js` passes the frontend with that mapping and `undici-types+6.21.0.patch`; not built or run natively. The shim's path depends on the scriptc install, so the daemon's native tsconfig has to be generated at build time. |

Also established: `fork()` with an IPC channel works natively when the worker path is a static `new URL(..., import.meta.url)`; the worker is embedded in the same binary. `packages/server/scripts/supervisor.ts` again behaves like upstream under Node (its six test files pass), but its Node launch code must move into a `.js` file before the supervisor compiles natively again.

scriptc gaps hit so far, each worked around in `patches/` ([docs/patches.md](docs/patches.md)):

- a union of two classes, including one that only exists in JSDoc (`SC3004`, reported without a location)
- `Object.defineProperty` and `Object.freeze` on classes (`SC2020`)
- a getter where the interface declares a data property, once plain and getter records share a slot (`SC1090`, `SC1100`)
- symbol-keyed class fields, `require()` of a JSON file with a large literal type, import cycles between ES modules

A build started at the repo root also typechecks the React Native app and fails on `@/utils/attempt-guard` (`SC1010`). The Makefile compiles from `packages/cli` so the CLI tsconfig is the one that applies.

## Docs

- [Build](docs/build.md)
- [Patches](docs/patches.md)
- [Targets](docs/targets.md)
- [Upstream candidates](docs/upstream.md): fixes worth sending upstream regardless of scriptc
