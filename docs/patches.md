# Patches

The `paseo/` submodule stays at its pinned tag with no local changes. The `work/paseo` submodule (branch `turbopaseo` of maci0/paseo) is that commit plus our source edits, and every patch, install, and build happens there. `make work` checks it out. `paseo/patches/` holds patches that ship with Paseo; `make paseo-deps` runs Paseo's `postinstall` script to apply them, because the install itself skips lifecycle scripts.

- `patches/paseo/*.patch` change Paseo's own source. `make source-patches` applies them, and `make paseo-deps` runs it before `npm install`, because `source.patch` removes dependencies from `packages/server/package.json`.
- `patches/*.patch` change installed packages. `make patches` applies them onto `work/paseo` after install.

Both targets skip a patch whose reverse applies cleanly, and stop on any other failure.

`make paseo-check` proves the patched tree is still a working Paseo under Node: Paseo's own `typecheck:server` and `build:server`, then the built JS CLI must print its `Usage:` line and the `packages/cli` version. Run it after changing any patch.

| Patch | Package | Why |
| --- | --- | --- |
| `zod+4.4.3.patch` | zod 4.4.3 | `v4/classic/schemas.js` and `iso.js` import each other at the top. scriptc rejects that cycle (`SC1016`). The ISO constructors and helpers live in `schemas.js`. `iso.js` re-exports them. |
| `ws+8.20.0.patch` | ws 8.20.0 | See [ws](#ws). |
| `commander+12.1.0.patch` | commander 12.1.0, under `packages/cli/node_modules` | `getOptionValueSource()` and `getOptionValueSourceWithGlobals()` declare `@return {(string|undefined)}` in JSDoc, as the `.d.ts` does; with `{string}`, scriptc checked the result and `paseo daemon start` threw on an option with no recorded source. `name()`, `alias()`, `aliases()`, `description()`, `summary()` and `usage()` are combined getters and setters that return `string \| Command`, a union scriptc cannot convert to a string. Internal reads use the fields (`_name`, `_aliases`, `_description`, `_summary`) and a new string-only `_usageText()`. `addHelpText()` entries are kept in arrays and written by `outputHelp()` directly, so the `beforeHelp`, `afterHelp`, `beforeAllHelp` and `afterAllHelp` events are no longer emitted. |
| `ajv+8.20.0.patch` | ajv 8.20.0, under `packages/server/node_modules` | A `require()` of `refs/json-schema-draft-07.json` has a literal object type scriptc cannot lower (`SC2001`). The patch inlines that file as `JSON.parse("…")`, which esbuild's `platform: "neutral"` bundle of the opencode bridge plugin also accepts; a `node:fs` read does not. It also drops the `exports.x = void 0` preludes and extends a local alias of `core_1.default`. The 55 TypeScript re-export getters (`Object.defineProperty(exports, name, { get })`) are plain assignments. ajv still cannot run natively, because it builds validators with `new Function`; native builds do not load it (see [native stand-ins](../README.md#native-stand-ins)). |
| `yaml+2.8.4.patch` | yaml 2.8.4 | Builds the JSON schema array with `push` instead of `concat`, writes the YAML 1.1 timestamp test as a regex literal instead of `RegExp(string + string)`, and exports `CST` as a plain object of its members instead of the module namespace. |
| `tweetnacl+1.0.3.patch` | tweetnacl 1.0.3 | The IIFE received `module.exports` or `self.nacl` through a conditional. It now fills a local object that is assigned to `module.exports` unconditionally. Every `var` declared without an initializer (66 declarators, all C-style locals assigned before they are read) starts at `0`, and `poly1305#finish` reads `this.leftover | 0`: scriptc refuses a possibly-undefined or untyped value as a typed-array index (`SC1090`), which stopped the daemon in key pair generation. A native build gives byte-identical key pairs, shared keys, boxes, `scalarMult` and `verify` results to Node for fixed inputs. |
| `@noble+curves+2.4.0.patch` | @noble/curves 2.4.0 | Annotates `mod` as `bigint` in JSDoc so scriptc does not lower it as number arithmetic, assigns `Point.BASE` and `Point.ZERO` after the class instead of as self-referencing static fields, and removes the `Object.freeze` calls on field and point classes. |
| `qs+6.14.2.patch` | qs 6.14.2 | `side-channel` pulls in `get-intrinsic`, `math-intrinsics` and `dunder-proto`, which scriptc rejects (`SC1010`, `SC1013`). The overflow tracker is a `WeakMap` and the per-call cycle tracker a `Map`. Output matches pristine qs on 11 parse and stringify cases. |
| `qrcode+1.5.4.patch` | qrcode 1.5.4 | `pngjs` is required inside the PNG renderer's `render()` so text output never loads it; `arguments` becomes a rest parameter; the string renderer picker returns the `render` function; `unescape(encodeURIComponent(s)).length` is counted without `unescape`; JSDoc types corrected where scriptc enforces them. `toCanvas.length` is 0 instead of 4. |
| `dijkstrajs+1.0.3.patch` | dijkstrajs 1.0.3 | The `typeof module !== 'undefined'` guard around `module.exports` is removed; scriptc cannot replace `module.exports` inside a conditional. |
| `@modelcontextprotocol+sdk+1.29.0.patch` | @modelcontextprotocol/sdk 1.29.0 | Adds an `"./*.js"` export entry with a `types` condition. Without it `./types.js` matched `"./*"` and resolved its types to `dist/esm/types.js.d.ts`, which does not exist. Daemon only. |
| `eventsource+3.0.7.patch` | eventsource 3.0.7 | Removes pass-through `addEventListener`/`removeEventListener` overrides; scriptc refuses to override them on a class extending `EventTarget`. Daemon only. |
| `undici-types+6.21.0.patch` | undici-types 6.21.0 (pulled in by `@types/node` 20) | Declares `bytes()` on the fetch body mixin, which Node provides. scriptc's built-in `@hono/node-server` 2.x calls `res.bytes()`; without the declaration the result is untyped and `outgoing.end(body)` matches the callback overload (`SC1090`). Types only, and it also applies to Node typechecks. Daemon only. |
| `markdown-it+10.0.0.patch` | markdown-it 10.0.0 (chat search in the daemon) | scriptc cannot hold a CommonJS module's exports object as a value (deferred `SC1090`, even through a top-level variable), and the daemon stopped at startup. The preset table reads each preset's `options` and `components` directly; `MarkdownIt#utils`, `MarkdownIt#helpers`, `utils.lib.mdurl` and `utils.lib.ucmicro` are plain objects with every export of those modules (mdurl 1.0.1, uc.micro 1.0.6), so plugins see the same members but not the module objects. `Renderer` reads `assign` as a member at its call site, because scriptc cannot prove the hoisted function runs after the top-level `var` is set (`SC1030`). A native build parses a sample with headings, entities, nested emphasis, lists, links, autolinks, raw HTML, a table, fenced and indented code and hard breaks into the same tokens as Node. |
| `linkify-it+2.2.0.patch` | linkify-it 2.2.0 (constructed by markdown-it) | `RegExp(...)` called without `new` (seven sites) is `new RegExp(...)`; for a string pattern they are the same, and scriptc cannot call the constructor as a plain function (`SC2020`). |
| `mdurl+1.0.1.patch` | mdurl 1.0.1 | `Url#parse` stored the protocol regex match and then the matched string in one variable; scriptc gives a variable one type (`SC2003`). Two variables, `proto` still `null` when there is no match. |
| `pkce-challenge+5.0.1.patch` | pkce-challenge 5.0.1 (MCP SDK OAuth client) | `crypto` held either Web Crypto or a promise of it (the `import("node:crypto")` fallback for Node older than 18), which scriptc cannot hold in one variable. It is `globalThis.crypto`, which every Node Paseo runs on (22 and later) provides. |
| `cross-spawn+7.0.6.patch` | cross-spawn 7.0.6 (MCP SDK stdio transport) | `module.exports._enoent` held the `./lib/enoent` module object; it is a plain object with that module's four exports. |
| `lru-cache+11.5.1.patch` | lru-cache 11.5.1, under `packages/server/node_modules` | The Node ESM export pointed at `index.min.js`, whose class expression with static initialisers scriptc refuses; it points at `index.js`, the same build unminified (also exported as `./raw`). `defaultPerf` held the global `performance` object (or `Date`) as a value; it is an object whose `now()` calls `performance.now()` (or `Date.now()`). Not a `paths` entry: `semver` uses the root lru-cache 6.0.0. |

## zod

Checked against Node and against a native scriptc binary (`--node-islands=off`):

```
z.string().parse("paseo")
z.string().datetime().parse("2020-01-01T00:00:00Z")
z.iso.datetime()
z.iso.time()
z.iso.duration()
z.date()
```

Node and the native binary both accept the datetime string `2020-01-01T00:00:00Z`. The native binary is an ELF that links libc and libm. It does not load Node.

## ws

- `kWebSocket` was `Symbol('websocket')`, stored as a class field. scriptc rejects a symbol-keyed field (`SC1090`), so it is the string `'kWebSocket'`. The key is the same on the receiver, the sender, the socket, and `WebSocket`. Nothing in Paseo imports that symbol.
- `Object.defineProperty` has no scriptc lowering (`SC2020`). The ready-state constants are `static` class fields (a static assigned after the class cannot be read, `SC1090`) plus plain prototype assignments, and `onopen`, `onerror`, `onclose`, and `onmessage` are getter and setter pairs in the class body.
- `Receiver.createError` declared `@return {(Error|RangeError)}` in JSDoc. TypeScript applies JSDoc types in JS files, and scriptc cannot hold a union of two classes, so every program that loaded the `WebSocket` class failed with `SC3004` (`a '{ className: string; kind: string }' value is not representable in the target union`). The patch declares `@return {Error}`.
- `emitErrorAndClose` has a malformed upstream JSDoc line, `@param {Error} The error to emit`, with no parameter name. `err` was therefore untyped and received both `Error` and `SyntaxError`. With that in the program, a listener registered on any `EventEmitter`, in `ws` or anywhere else, failed with the same `SC3004`. The patch names the parameter.
- The ready-state constants on instances are getters, and `addEventListener`/`removeEventListener` are class methods that call `addListener(target, ...)`/`removeListener(target, ...)` in `event-target.js`; scriptc has no assignment to a prototype.
- `WebSocketServer` calls `listen()` without the `backlog` argument when none is set, and without a callback when none is given.
- These make `ws` load natively. It still cannot connect: see [native stand-ins](../README.md#native-stand-ins). Native builds use `native/ws/` instead.
- `Buffer[Symbol.species]` reads use `Buffer`, the validator picks its UTF-8 function before exporting, and `event-target.js` drops the calls that only mark existing getters enumerable, so `target`, `type`, `code`, `reason`, `wasClean`, `error`, `message`, and `data` on ws events no longer show up in `Object.keys` or a spread.

## Paseo source

`patches/paseo/source.patch` holds the edits to Paseo's own packages. The ones that change how code is written, with the scriptc limit behind each:

- `packages/client/src/node/index.ts`: the per-socket `socket.send = ...` override is a `BudgetedWebSocket` subclass (assignment to a method is unsupported). Its close listener is registered through `onSocketClose`, typed by JSDoc as `WebSocketLike`, because the CLI compiles this package from `dist` JS where TypeScript casts are gone. `terminate()` is called through the subclass method `forceClose()`. Locals from `parseHostTarget()` carry an explicit `HostTarget` annotation; without it scriptc does not narrow the union on `kind`. `createHostClient` spreads `config` whole instead of using a rest binding.
- `packages/client/src/node/index.ts` and `hosts/index.ts`: `supportsDrain` and `maxFrameBytes` on the wrapper transports are data properties that are assigned when the inner transport changes, not getters. scriptc rejects a getter where `DaemonTransport` declares a data property once both forms exist in one program.
- `packages/client/src/timeline-subscription/index.ts`: `subscriptionId` is a getter in the object literal instead of `Object.defineProperty`.
- `packages/protocol/src/chunked-transport.ts`: JSDoc `@type` and `@returns` on the write queue, so the emitted JS keeps a type for `completion`.

## which

`@getpaseo/server` imported `which` 2.0.2, which ships no `.d.ts`. scriptc refuses that (`SC2013`). The server now scans `PATH` itself in `packages/server/src/executable-resolution/executable-resolution.ts`. On non-Windows it still prefers `/usr/bin/which -a` when that binary exists. That change is part of `patches/paseo/source.patch`.

## Daemon program limits

Hit while compiling the whole daemon (`make daemon`); each workaround is in `patches/paseo/source.patch`.

- An npm package that only a `fork()` target imports is not compiled (`SC2013`, "its implementation is not part of the compiled module graph"). `native/entries/daemon/index.ts` names each forked module (daemon worker, terminal worker, speech worker) in a branch that never runs, which puts their packages into the program.
- scriptc's IR stage fails with `SC9001` (internal compiler error) in three cases. Each reproduces in a few lines except the last:
  - `cond ? null : asyncGenerator()` ("union ...: arm 0 is generator"). The generator is held in a record instead (`{ events: gen() }`), in `agent-manager.ts`.
  - Any `process.getBuiltinModule(...)` call, from TypeScript or JavaScript, in a program that also has a foreign-thread FFI callback ("worker execution cannot install foreign-thread callbacks"). The daemon has two (`native/pty`, `native/sherpa`). Server code loads Node-only builtins with `requireNodeOnly` (`node-only-require.js`), and the built-in plugins use `loadNodeBuiltin` from `@getpaseo/plugin/server`, which returns `undefined` for a builtin the running Node lacks, as `getBuiltinModule` does.
  - A method returning a promise of `Omit<Extract<SessionOutboundMessage, ...>["payload"], ...>` ("call ... type dyn != return promise"). Only in the full program; a small one compiles. `CheckoutDiffSnapshotPayload` is declared from server types instead; the sites that send it in a message still check it against the wire schema. A generic class whose type argument is a protocol `z.infer` alias fails the same way and takes a local `interface X extends Alias {}`.
- `typeof` of an npm module in a type position makes scriptc compile that package (`SC2013` for `undici`). Node-only packages are described by a local interface instead.

## Adding a patch

A source edit: change the file under `work/paseo`, then `make source-patch`. It regenerates `patches/paseo/source.patch` from the work tree's own git repo, whose only commit is the pristine export, including new files and leaving out `package-lock.json` (`npm install` brings it in line with the patched `package.json`) and the generated `packages/*/native/` entry directories.

A package edit: diff the edited package against its published tarball and save it as `patches/<name>+<version>.patch` with paths `a/<path from work/paseo>` and `b/<path from work/paseo>`, for example `a/node_modules/ws/...` or `a/packages/server/node_modules/ajv/...`. `patch -p1` from `work/paseo` must apply it, and applying it to the pristine tarball must reproduce the installed files. Do not put these files in `paseo/patches`.

Never edit `paseo/` itself; `make work` refuses to run while it has local changes. Commit source edits on the `turbopaseo` branch in `work/paseo`, regenerate `source.patch`, and commit the new submodule pointer here.
