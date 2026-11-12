# Build

The entry is `native/entries/cli/index.ts`, which only imports Paseo's `packages/cli/src/index.ts`. `make` copies it and its `tsconfig.json` into `work/paseo/packages/cli/native/` and compiles there. scriptc reads the tsconfig nearest the entry, and that one maps packages that cannot run natively onto the stand-ins under `native/` with `paths` (`ws` to `native/ws/index.ts`), also for `require()` calls inside npm packages. Paseo's own `packages/cli/tsconfig.json` is untouched, so Node builds keep the real packages. `work/paseo` is the working-tree submodule: the `paseo/` submodule's commit plus our source edits ([patches](patches.md)). That module loads the CLI and, through `@getpaseo/server`, the daemon the `paseo daemon` commands start. scriptc follows those imports and compiles them into one executable.

`make` runs scriptc from `work/paseo/packages/cli/native`. The repo-root tsconfig includes the React Native app, and a build started there fails on app imports (`@/utils/attempt-guard`) before it reaches the daemon.

```
make paseo-deps
make paseo-check
make
```

`paseo-deps` checks out the `work/paseo` submodule if it is not there, applies `patches/paseo/` where it is not already applied, installs the workspace with npm (`--ignore-scripts`), runs Paseo's `postinstall` script by name so `paseo/patches/` is applied, applies `patches/*.patch` to `node_modules`, then builds `@getpaseo/protocol`, `@getpaseo/relay`, `@getpaseo/client`, `@getpaseo/highlight`, `@getpaseo/plugin`, and `@getpaseo/server`. scriptc resolves the workspace packages from those `dist/` trees. `paseo-check` then runs Paseo's own `typecheck:server` and `build:server` and the built JS CLI under Node, so a patch that breaks normal Paseo fails there.

## Requirements

| Tool | Used for |
| --- | --- |
| scriptc 0.4.10 | compile |
| Node 24+ and npm | install Paseo and build its workspace packages |
| clang | link the host executable on glibc Linux and macOS |
| zig | link the Linux and macOS targets that are not this machine |

`SCRIPTC` defaults to `.scratch/scriptc-tool/node_modules/.bin/scriptc`. Point it at another binary with `make SCRIPTC=scriptc`.

## Flags

`OPTIMIZATION` is `release` or `dev`. `dev` is `-O0` with debug info. `NODE_ISLANDS` is `off`. scriptc 0.4.10 treats `--node-islands` as report-only on a build, and a package outside the native subset is still a compile error (`SC2013`). Leaving the flag set records that this tree is built that way.

```
make OPTIMIZATION=dev
```

## What the compile does

1. Typecheck the entry with scriptc's settings (strict null checks, ES2025, Node types).
2. Lower the program and every imported package to native code.
3. Link an executable for `SCRIPTC_TARGET`, or for the host when the target's runtime pack is the one shipped with the compiler.

A failure stops before any binary is written. Diagnostics name a file, a line, and an `SC` code. `docs/patches.md` lists the ones already patched.

## What compiled

The CLI compiles, links and runs; the status table in the [README](../README.md#status) lists what is verified. `make OPTIMIZATION=dev` is the fast loop (about 2 min 15 s here).

To check only whether scriptc's frontend accepts a program, without LLVM:

```
scriptc build file.ts --emit=ir -o out.ir --node-islands=off
```

The frontend (parsing, type checking, lowering, LLVM IR generation) runs on one thread, and scriptc has no setting to change that; it is skipped only when no input changed. Code generation is already parallel: the LLVM helper compiles the executable in partitions, one thread per hardware thread, and caches each partition, so a rebuild recompiles only the partitions whose functions changed. `make dist` builds the CLI, the daemon and `tp` one after another: a release build of the CLI peaked above 60 GB in the LLVM helper (killed at a 60 GB cap on 32 and on 8 CPUs, and at 32 GB), so two at once do not fit next to other work on a 123 GB machine.

`make daemon` builds `builds/paseo-daemon-<host>` from `native/entries/daemon/index.ts`. `packages/server/scripts/supervisor-entrypoint.ts` forks `packages/server/src/server/daemon-worker.ts`; scriptc supports `fork()` with an IPC channel when the worker path is a static `new URL(..., import.meta.url)`, and embeds the worker in the same binary.

## dist

`make dist` builds the host CLI and the daemon (both rebuilt every time, at `OPTIMIZATION`, `release` by default, one after the other), gathers them into `dist/paseo-<version>-<host>/`, and packs that directory as `dist/paseo-<version>-<host>.tar.gz` with its SHA-256 sum in `.tar.gz.sha256`. It also builds `tp` (`tp/index.ts`, `make tp`) and copies it to `dist/tp-<host>` with `tp-<host>.sha256`. Those four files are the assets of a GitHub release, which `tp install`, `update` and `self-update` download. `<version>` is the `paseo/` submodule's version (`0.15.4`).

| Path | What |
| --- | --- |
| `paseo` | CLI (`builds/paseo-<host>`) |
| `paseo-daemon` | daemon (`builds/paseo-daemon-<host>`); the native CLI starts the `paseo-daemon` beside its own binary |
| `icudt78l.dat` | ICU data, read from the binary's own directory |
| `lib/libsherpa-onnx-c-api.so`, `lib/libonnxruntime.so` | speech libraries, found through the daemon's RUNPATH `$ORIGIN/lib` |
| `assets/silero_vad.onnx` | voice activity model |
| `builtin-plugins/`, `skills/`, `shell-integration/`, `opencode/` | files the daemon reads at run time, from Paseo's server build |
| `LICENSE` | Paseo's license |

A native binary finds these files beside `process.execPath`, so the directory can move, and a symlink to `paseo` from a `bin` directory works: the CLI starts the `paseo-daemon` beside the resolved binary.
