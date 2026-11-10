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

The frontend (parsing, type checking, lowering, LLVM IR generation) runs on one thread, and scriptc has no setting to change that; it is skipped only when no input changed. Code generation is already parallel: the LLVM helper compiles the executable in partitions, one thread per hardware thread, and caches each partition, so a rebuild recompiles only the partitions whose functions changed. Separate programs can build side by side, which is why `make dist` builds the CLI and the daemon at the same time.

The daemon is not built yet. `packages/server/scripts/supervisor-entrypoint.ts` forks `packages/server/src/server/daemon-worker.ts`; scriptc supports `fork()` with an IPC channel when the worker path is a static `new URL(..., import.meta.url)`, and embeds the worker in the same binary.

## dist

`make dist` builds the host CLI and the daemon (both rebuilt every time, at `OPTIMIZATION`, at the same time) and gathers them into `dist/paseo-<host>/`:

| Path | What |
| --- | --- |
| `paseo` | CLI (`builds/paseo-<host>`) |
| `paseo-daemon` | daemon (`builds/paseo-daemon-<host>`) |
| `icudt78l.dat` | ICU data, read from the binary's own directory |
| `lib/libsherpa-onnx-c-api.so`, `lib/libonnxruntime.so` | speech libraries, found through the daemon's RUNPATH `$ORIGIN/lib` |
| `assets/silero_vad.onnx` | voice activity model |

The directory is not relocatable yet. The daemon locates built-in plugin manifests and shell integration through `import.meta.url`, which in a native binary is the build-time source path, so it reads them from `work/paseo`. Other runtime files may do the same (see below).

## Layout of a finished binary

The executable does not read `node_modules` at run time. Files the daemon still opens from disk (skills, builtin plugins, the ONNX voice asset, shell integration) are copied into the server `dist/` by Paseo's own build and are not embedded by scriptc. A CLI binary that gets past `SC3004` still needs those paths, or a later change that embeds them.
