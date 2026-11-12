# Performance

Measured on 2026-11-12, Linux x86-64, 32 hardware threads, Node 26.13.1, scriptc 0.4.10. The machine was shared with other builds, so wall times vary between runs; CPU time and instruction counts (`instructions:u`) are the numbers to compare.

## Method

`.scratch/bench.sh <native|node>` runs one implementation in isolation: `env -i`, a fake `HOME` under `~/.cache/paseo-bench/<impl>`, the daemon on its own loopback port (47235 native, 47236 Node) with relay, MCP, dictation and voice mode off. It checks the daemon's sockets (no connection to 6767, loopback listeners only) and that the host's `~/.paseo` state files did not change. CLI commands run under `hyperfine -N` (3 warm-ups, 10 to 20 runs); daemon CPU is the summed `utime + stime` (and waited-for children) of the daemon's process tree from `/proc/<pid>/stat`.

`native` is the dev package `.scratch/pkg-dev/paseo-0.15.4-linux-x64.tar.gz`, built before the zod change below. `node` is `work/paseo/packages/cli/bin/paseo` under the host's Node.

## Dev build against Node

A dev build is `-O0` with debug info and links scriptc's unoptimised runtime, so these numbers say how the dev build behaves, not how a release build will.

| Command | Native dev CPU | Node CPU | Native instructions | Node instructions | Native peak RSS | Node peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| `--version` | 784 ms | 648 ms | 6.08 G | 3.50 G | 300 MB | 194 MB |
| `--help` | 694 ms | 576 ms | 6.10 G | 3.52 G | 303 MB | 195 MB |
| `daemon status`, daemon down | 686 ms | 640 ms | 6.10 G | 3.52 G | 307 MB | 196 MB |
| `daemon status`, daemon up | 698 ms | 524 ms | 6.15 G | 3.69 G | 319 MB | 195 MB |
| `ls` | 780 ms | 622 ms | 6.13 G | 3.65 G | 316 MB | 197 MB |

The native CLI's CPU time equals its wall time (one thread); Node's CPU time is about 1.6 times its wall time.

| Daemon | Native dev | Node |
| --- | --- | --- |
| CPU to finish `daemon start` (3 runs) | 2.39, 1.96, 1.85 s | 3.96, 3.60, 3.40 s |
| CPU over 10 s idle | 230 ms | 50 ms |
| CPU for 26 CLI requests (`daemon status`, `ls`) | 630 ms | 200 ms |
| RSS of the process tree | 793 MB, 2 processes | 578 MB, 3 processes |
| Wall time of `daemon stop` | 736 to 1131 ms | 378 to 608 ms |

The native daemon in this package predates the shutdown fix ([upstream](upstream.md), scriptc#3583), so its stop times are not final.

## Where the CLI's start-up goes

Every command costs the same 6.1 G instructions, so the time is start-up, not the command. `perf record -e cycles:u --call-graph=fp --user-callchains` of `paseo --version` (`.scratch/prof.sh`; `perf_event_paranoid` is 2 here, so only user-space events, and a call graph needs `--user-callchains`), with `.scratch/stacks.ts` attributing each sample to its innermost program frame:

- 82% of samples are in scriptc's runtime: 38% the cycle collector (`scr_cyc_*`, mark and scan), 25% dynamic objects (`scr_dyn_*`), 19% the rest. 11% is compiled program code.
- 29% of samples have `zod/v4/classic/schemas.js:55`, the `ZodType` initialiser, as their innermost program frame. It gave every schema about 13 per-instance closures that capture the schema, and `ZodString` added 27 more. Each closure and its schema form a reference cycle, and releases during construction keep scheduling cycle-collector passes.
- The schemas are the protocol's: `packages/protocol/dist/messages.js` makes about 3,760 schema-building calls and `hosts.js` 86, all at module load. Module initialisers of `@getpaseo/protocol` hold 26.6% of samples inclusively. 88% of samples sit under one dynamic class constructor, and most of those stacks lose their callers inside the runtime before reaching a module initialiser, so the real share is higher.
- The dev runtime is unoptimised: `scr_cycle.o` in `artifacts/dev` has 1616 `%rbp` stack moves, the release one 5.

## Schema probe

`.scratch/schema-probe/index.ts` imports `@getpaseo/protocol/messages` and `@getpaseo/protocol/hosts` and prints the export count (572). Built with `.scratch/probe-keep.sh`.

| Build | Before the zod change | After |
| --- | --- | --- |
| scriptc dev, instructions | 4.62 G | 3.85 G (-17%) |
| scriptc release, instructions | 1.59 G | 1.38 G (-13%) |
| scriptc release, CPU (same load, 10 runs) | 237 ms | 203 ms (-14%) |
| scriptc release, peak RSS | 134 MB | 79 MB (-41%) |
| scriptc dev, peak RSS | 152 MB | 90 MB (-41%) |
| Node 26, CPU / instructions | 210 ms / 1.64 G | 181 ms / 1.41 G, measured with the parse-family and string change only |

A release build loads the protocol schemas in fewer instructions than Node.

## The zod change

`patches/zod+4.4.3.patch` ([patches](patches.md)) moves the parse family (`parse`, `safeParse`, the async, encode and decode variants, `spa`) and `toJSONSchema` of `ZodType`, and the 27 string-format methods of `ZodString`, onto zod's own lazy-bind mechanism (`_installLazyMethods`): a prototype getter binds the method on first access and caches it as an own property. Detached use (`const { parse } = schema`) and repeated reads (`schema.parse === schema.parse`) behave as before; the methods are no longer own enumerable properties of a schema that has not used them. `~standard` stays lazy instead of being read in the constructor to attach `jsonSchema`.

`.scratch/zod-check/index.ts` covers these: 19 checks pass under Node; natively the 17 that do not export JSON Schema pass. Paseo's `messages.attachments.test.ts` (12 tests) and `agent-response-loop.test.ts` (11 tests) pass under Node with the patch.

## The daemon client loads on first connection

The CLI imported `@getpaseo/client` statically, and the client imports the protocol's `messages.js`, so every command built the message schemas. `packages/cli/src/utils/daemon-client-runtime.ts` now re-exports the client values the CLI uses (`createHostClient`, `DaemonConnectionError`, `requireTerminalKeepCapability`, `createPaseoApi`), and the five call sites load it with `await import()` once they have a connection. `PluginIdSchema` and `parseHostTarget` come from `@getpaseo/protocol/plugin-config` and `host-target`, which do not reach `messages.js`. `.scratch/reach.ts` walks the runtime imports of the built JS: before the change `packages/cli/dist/index.js` reached `messages.js` through `commands/daemon/status.js` and `@getpaseo/client`; after it, it does not.

scriptc compiles a dynamic `import()` of a local module and runs that module's initialisers only when the import runs: a release probe that skips the import costs 0.3 M instructions, one that takes it 1.39 G. A dynamic `import()` of a package specifier fails to compile (`SC2013`), so the indirection has to be a local file.

## Dev build against Node, with both changes

Measured on 2026-11-13 with load average 20 to 50 from other builds, so CPU times are inflated on both sides and instruction counts are the comparison. Native is the dev CLI built from `dbe292b` (`builds/paseo-linux-x64` at the time, saved as `.scratch/paseo-dev-lazy`) inside the same dev package, so the daemon is still the old one; `NATIVE_CLI=<binary> .scratch/bench.sh native` swaps it in.

| Command | Native dev before | Native dev after | Node before | Node after |
| --- | --- | --- | --- | --- |
| `--version` | 6.08 G, 784 ms, 300 MB | 1.02 G, 291 ms, 166 MB | 3.50 G, 648 ms, 194 MB | 1.33 G, 200 ms, 89 MB |
| `--help` | 6.10 G, 694 ms, 303 MB | 1.02 G, 307 ms, 167 MB | 3.52 G, 576 ms, 195 MB | 1.34 G, 219 ms, 89 MB |
| `daemon status`, daemon down | 6.10 G, 686 ms, 307 MB | 1.04 G, 289 ms, 171 MB | 3.52 G, 640 ms, 196 MB | 1.37 G, 218 ms, 89 MB |
| `daemon status`, daemon up | 6.15 G, 698 ms, 319 MB | 5.27 G | 3.69 G, 524 ms, 195 MB | 3.34 G, 597 ms, 175 MB |
| `ls` | 6.13 G, 780 ms, 316 MB | 5.23 G | 3.65 G, 622 ms, 197 MB | 3.34 G, 589 ms, 174 MB |

Each cell is instructions, CPU, peak RSS. A command that never connects runs in a sixth of the instructions natively and fewer than Node's. A command that connects still loads the client and the schemas, so it gains only the zod change (14%). The native CPU of the connected commands (about 1.6 s) was measured at load average 50 and is left out.

The dev CLI built in 8 min under a 48 GB cap (`make OPTIMIZATION=dev`, no cache for the changed partitions); a 40 GB cap was too small.

Output against the Node CLI, both from the same fake home (`.scratch/cmp-iso.sh`, `env -i`, config pointing at an unused port or at an isolated Node daemon on 127.0.0.1:47298, host `~/.paseo` checked): 44 of 44 commands without a daemon identical in stdout, stderr and exit code (`--version`, `--help`, 34 command help screens, an unknown command, `ls`, `ls --json`, `daemon status`, `provider ls`, `workspace ls`, `terminal ls`, `daemon config get`). Against the daemon, 16 of 17 identical; `provider ls` differs only on the first call after `daemon start`, where the native CLI, which runs first, sees providers `loading` and Node a moment later `unavailable`; a second call matches.

## What `--version` still spends

A profile of the dev CLI above (`--version`, 1.02 G instructions, 3,914 samples) by module initialiser: zod schemas built at load are about 33% (`server/persisted-config.js` 10.9%, the hub client's `contracts.ts` 5.7%, `terminal-worker-record.js` 4.4%, `protocol/plugin-registry.js` 3.2%, `connection-offer.js` 2.0%, smaller ones below 1.5%), building commander's command tree about 20% (`createCli` 9.2%, `createTerminalCommand` 8.0%), and one cycle-collector pass that ran during `Command.addOption` another 10%. `persisted-config.js` comes through `@getpaseo/server/daemon-control`, which most commands use.

The hub contracts and problem schemas now load on the first hub request (`work/paseo` `853e90f`): `HubHttpClient`'s methods import `internal/contracts.js` and `internal/transport.js` when they send. `.scratch/reach.ts` confirms neither, nor `messages.js`, is reachable from `packages/cli/dist/index.js`. Under Node `--version` went from 1.33 to 1.31 G instructions. The native gain (about 5.7% of 1.02 G by the profile) is not measured: the release build was running, and a dev build needs 48 GB beside it. The hub test files `client`, `deploy-contract`, `login-flow` and `commands` (35 tests) pass under Node.

## The idle daemon

`.scratch/idle-prof.sh` records the dev package's daemon for 20 s after it has settled (376 samples at 999 Hz, about 0.38 s CPU, matching the 230 ms per 10 s above). 56% is scheduled cycle-collector passes (`scr_cyc_collect_scheduled` from `scr_loop_run_pass`) that re-trace long-lived objects: the voice WebSocket server (11.5% inclusive), the config store, plugin runtime, output capture and session socket (about 6% each). Program code is 1.1%. A repro with a long-lived cyclic graph of typed class instances and a 100 ms timer that makes and drops a closure over it (`.scratch/scriptc-bugs/idle-cycle-scan/`) does not show it: 0 to 2 ms CPU over 3 s with up to 1 M objects natively (Node: 572 ms at 1 M). The daemon's traced values are dynamic objects, closures and boxes (`scr_dyn_trace_v`, `scr_closure_trace`, `scr_box_trace`), so the trigger is in untyped JS; it is not found yet.

## Not done

- The release CLI and daemon are not measured; the release build needs more than 60 GB ([build](build.md)).
- No release-build profile: the release binary has no symbols, so its samples cannot be attributed.
- A command that connects to the daemon still builds all protocol schemas; making them lazy is a change inside `@getpaseo/protocol`.
- The idle daemon's cycle-collector trigger.
