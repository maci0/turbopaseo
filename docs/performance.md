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

A release build loads the protocol schemas in fewer instructions than Node. The full release CLI has not been measured: its build needs more than 60 GB in the LLVM step ([build](build.md)), and a dev rebuild of the CLI without cache was killed at a 40 GB cap.

## The zod change

`patches/zod+4.4.3.patch` ([patches](patches.md)) moves the parse family (`parse`, `safeParse`, the async, encode and decode variants, `spa`) and `toJSONSchema` of `ZodType`, and the 27 string-format methods of `ZodString`, onto zod's own lazy-bind mechanism (`_installLazyMethods`): a prototype getter binds the method on first access and caches it as an own property. Detached use (`const { parse } = schema`) and repeated reads (`schema.parse === schema.parse`) behave as before; the methods are no longer own enumerable properties of a schema that has not used them. `~standard` stays lazy instead of being read in the constructor to attach `jsonSchema`.

`.scratch/zod-check/index.ts` covers these: 19 checks pass under Node; natively the 17 that do not export JSON Schema pass. Paseo's `messages.attachments.test.ts` (12 tests) and `agent-response-loop.test.ts` (11 tests) pass under Node with the patch.

## Not done

- Lazy loading of the protocol schemas in the CLI: the change is in Paseo's source and all of it is reached from `packages/cli/src/index.ts` at start-up.
- The native daemon's idle CPU (230 ms per 10 s against Node's 50 ms) is not profiled.
- No release-build profile: the release binary has no symbols, so its samples cannot be attributed.
