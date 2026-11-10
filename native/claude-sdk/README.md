# native/claude-sdk

`query` and `forkSession` from `@anthropic-ai/claude-agent-sdk` 0.3.246, ported from the package's `sdk.mjs` for scriptc builds of Paseo. Node builds keep the real package.

The SDK bundle does not compile under scriptc (28 internal compiler errors, `SC9001`). Paseo uses two values from it, `query` and `forkSession`; everything else it imports is a type. `index.ts` re-implements those two against the `claude` CLI's stream-json stdio protocol and re-exports every SDK type from a copy of the package's `sdk.d.ts`.

| File | Role |
| --- | --- |
| `index.ts` | the module: CLI argument and environment construction, process transport, `Query`, `query()`, `forkSession()` |
| `sync-types.sh` | copies the SDK's `sdk.d.ts`, `sdk-tools.d.ts` and `agentSdkTypes.d.ts` into `types/` (gitignored; the files belong to the SDK) |
| `tsconfig.json` | maps `@anthropic-ai/claude-agent-sdk` to `index.ts` with `paths`, as the daemon build does |
| `test.sh` | runs the scenario suite through the real SDK, this module under Node, and this module as a scriptc binary, and diffs the three |
| `tests/fake-claude.ts` | a fake `claude` CLI (Node) that speaks the protocol and records argv, environment, stdin and signals |
| `tests/scenarios.ts` | the 32 query scenarios and 19 `forkSession` cases |
| `probes/paseo-spawner.ts` | Paseo's spawner shape, which fails natively (see [Paseo changes](#paseo-changes)) |

`node_modules` is a symlink to `work/paseo/node_modules` (gitignored): `ln -s ../../work/paseo/node_modules native/claude-sdk/node_modules`.

## Selecting it

```json
"paths": {
  "@anthropic-ai/claude-agent-sdk": ["<root>/native/claude-sdk/index.ts"]
}
```

Run `./sync-types.sh` before a native build (`test.sh` runs it). The mapping redirects type imports too, so `index.ts` cannot import the package by name (it would resolve back to itself). It imports the declarations from `./types/sdk.js` and re-exports them with `export type *`.

The declarations must not come from the package directory (`./node_modules/@anthropic-ai/claude-agent-sdk/sdk.js`). With the mapping, scriptc then rejects every program that reaches `index.ts` through the package name: `SC9001 internal compiler error: union ...: arm 0 is generator` for Paseo's `providers/claude/query.ts`, and `SC1090 'SDKUserMessage[]'-typed class fields are not supported yet` (39 errors) for `tests/scenarios.ts`. It happens only when the mapped specifier names the package whose directory holds the imported `.d.ts`: the same `index.ts` mapped as `zz-claude-sdk`, `@anthropic-ai/zz` or `@anthropic-ai/sdk`, or imported by relative path, compiles.

Every SDK type in the program must also come from one copy. A program that mixes the package's `sdk.d.ts` with `types/sdk.d.ts` builds, but natively each `query()` throws `TypeError: expected AsyncGenerator at $, got object` at its `return` (`Query` extends `AsyncGenerator`). That was the old standalone test build, where `tests/scenarios.ts` imported the package's types unmapped: every scenario failed at once, left its fake CLI running and waited 15 s for its exit, so the run hit the 300 s timeout. With the mapping, every import of the package, type imports in npm packages included, resolves to `index.ts`.

Verified with a probe in `packages/server/` and the daemon's `tsconfig.template.json` mapping: `scriptc build --emit=ir` of an entry importing `providers/claude/query.js` compiles; an entry that adds `provider-registry.js` fails only on errors outside this module (`zod-to-json-schema` `delete`, `acp-agent.ts:3642`, `copilot-acp-agent.ts:193`); `tsgo -p` over both entries reports no errors (with `baseUrl` removed, which tsgo rejects with `TS5102`). A native build of one `claudeQuery` turn against `tests/fake-claude` (initialize, user message, `result`, `supportedModels()`, stdin end, exit 0) prints the same as the same probe under Node with the real SDK.

## Test

```console
$ ./test.sh
sdk: 342 query lines, 131 fork lines
node: 342 query lines, 131 fork lines
native: 342 query lines, 131 fork lines
PASS
```

The `sdk` run is `node tests/run-sdk.ts` (the package by name, which Node resolves to the real SDK), `node` is `node tests/run-native.ts` (`../index.ts` by path), and `native` is `tests/run-sdk.ts` built with scriptc, where `tsconfig.json`'s `paths` resolve the package name to `index.ts`: the daemon's configuration. `SCENARIO=<name>` runs one query scenario and skips the `forkSession` cases; `SCENARIO_TRACE=1` prints each line to stderr (`<OUT_DIR>/<run>.stderr`) as it happens, with the stack of a scenario that throws.

No real CLI or API is used. Every query scenario spawns `tests/fake-claude` (`pathToClaudeCodeExecutable`), either through the SDK's own spawn or through a Paseo-style `spawnClaudeCodeProcess`. Each run prints what the caller observes (messages, callback arguments, return values, error names and messages, `process` warnings) and then the fake's record (argv, cwd, environment, every stdin line with request ids normalized, stdin end, SIGTERM, exit code). The real SDK run is the reference. Run time is about 30 s per run. Replacing the `keep_alive` drop with a pass-through makes the `node` run differ in one line.

Covered: every option Paseo sets (`agent.ts` `buildOptions`, `model-discovery.ts`) plus thinking, budget, plugin, skills, tools, sandbox and settings variants; the `initialize` request and its `pending_permission_requests`; `keep_alive` and `transcript_mirror` dropping, `commands_changed`, non-JSON, blank, CRLF, CR and split lines, primitive and `null` lines; `can_use_tool` (all option fields, a throwing callback, cancellation), `hook_callback` (known and unknown ids), unsupported subtypes, `mcp_message`, `elicitation`, `oauth_token_refresh`; every Paseo control method plus the rest of the public `Query` interface and `cancelAsyncMessage`; control request errors; exit codes, death by signal, stderr tails, error results; abort via `abortController` (CLI exits, CLI needs SIGTERM after the 2 s grace), `close()`, `return()`, `break` out of `for await`, SIGKILL 5 s after SIGTERM; string prompts; spawn failures; option validation errors. `forkSession` runs on synthetic transcripts in a scratch `CLAUDE_CONFIG_DIR`, through a copy of Paseo's file-backed `SessionStore` and through the disk path (with and without `dir`, sidecar `custom-title.json`, title fallbacks, `upToMessageId` at progress and sidechain entries, invalid ids). Output files are compared byte for byte after replacing generated UUIDs by first-appearance names and generated timestamps by `<now>`, which also checks that `parentUuid` and `logicalParentUuid` links stay consistent.

## Native differences

These are scriptc runtime behaviours, observed with the suite. The suite accounts for each where noted.

- A typed record serializes in its type's declaration order natively, in insertion order under Node. This changes the key order (not the content) of `--settings` JSON built from an `Options.settings` object, and of entries a `SessionStore.append` receives (`type`, `uuid`, `timestamp` first). The suite declares settings in type order and sorts keys in its store. The disk path writes untyped records and matches byte for byte.
- A child under scriptc reports stdout end and exit together; under Node, a CLI that half-closes stdout before exiting is seen to end stdout first. After an abort the SDK raises "Operation aborted" in the first order and "Claude Code process aborted by user" in the second. Both are the SDK's `AbortError`. `abort-graceful` treats them as one.
- When a message and a control request arrive in one read, whether the consumer sees the message before the callback runs depends on microtask order. The fake pauses 50 ms before its first request.

## Not ported

- `Options.sessionStore` in `query()` and SDK MCP server instances (`type: "sdk"`): `query()` throws.
- The SDK's debug log (`DEBUG_CLAUDE_AGENT_SDK` writing `~/.claude/debug/sdk-*.txt` and adding `--debug-file`), its telemetry events, OpenTelemetry `traceparent` propagation into the CLI environment, and secret redaction of stderr tails and paths in error messages.
- Options absent from `sdk.d.ts` (`getOAuthToken`, `getHostAuthToken`, `workload`, `channels`, `resolvePermissionModeInCli`): ignored, so `oauth_token_refresh` and `host_auth_token_refresh` are answered with the SDK's "not provided" errors.
- `Query` methods outside the public interface except `cancelAsyncMessage` (for example `setCwd`, `getSettings`, `askSideQuestion`), and `interrupt({ cancelQueued })`.
- `forkSession` on disk: the scan for hash-suffixed project directories of paths over 200 characters, and the SDK's alternate transcript storage backend.
- Without `pathToClaudeCodeExecutable`, the bundled CLI is found by walking `node_modules` above this file (glibc package first; no musl detection). Not run natively.
- Windows paths (`win32` branches are ported but untested).

## scriptc limits hit

| Limit | Workaround |
| --- | --- |
| declarations imported from the directory of the package a `paths` entry maps to this module (`SC9001`, `SC1090`) | `types/` copies from `sync-types.sh` |
| a `Query` from a second copy of the declarations: the conversion checks it as a built-in `AsyncGenerator` at run time | one copy for the whole program, through the mapping |
| `spawn()` `signal` option (`SC2020`) | `LocalProcess` emulates it: on abort a live child gets SIGTERM and an `AbortError` `'error'` |
| `spawn()` with `cwd: undefined` throws at run time | two `spawn()` calls |
| `.return(value)` on a `void` generator (`SC1071`) | `return()` takes no argument |
| `require.resolve` with a computed request (`SC2020`) | `node_modules` walk |
| `execFile` `timeout` (`SC2020`) | a timer sends SIGTERM |
| a cast to `HookInput` (31-arm union) checks the CLI's JSON at run time | the callback is called through an `unknown`-typed signature |
| a spread into a typed record reorders keys | `failIfUnavailable` and fork entries are built as untyped records |
| `readline.createInterface` over the child's stdout (brief) | `LineReader`: readline's splitting (`\n`, `\r\n`, `\r`, 100 ms CRLF delay, final partial line) |

Test-only: `appendFile` with an encoding argument (`SC2020`), assigning `string | undefined` to `process.env` (`SC1090`), returning `null` where `PermissionResult` is declared (run time), reading `.type` of a primitive message (run time).

## Paseo changes

Needed outside this directory, verified as noted:

1. `providers/claude/query.ts`: return a `SpawnedProcess` wrapper instead of the `ChildProcess`, and stop passing `signal` to `spawnProcess`. A raw `ChildProcess` builds but fails at run time (`child.on is not a function`, `probes/paseo-spawner.ts`); `spawn()` with `signal` fails the build. The wrapper is `SpawnedChild` in `tests/scenarios.ts`; the suite drives the real SDK through it under Node with identical results, including both abort paths.
2. `providers/claude/rewind.ts:45`: `appendFile(path, lines)` without `"utf8"` (the default for strings).
