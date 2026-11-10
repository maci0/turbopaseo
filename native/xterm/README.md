# xterm for the native daemon

The real xterm.js terminal emulator, compiled into the native daemon from its own TypeScript
sources. The npm packages ship webpack bundles with ambient `declare module` typings, which
scriptc does not compile (`new Terminal(...)` fails with SC1090 "constructing values other than
classes declared in the program"). The sources are the ones the bundles were built from, with
small local changes for scriptc, and Paseo's replay and capture output is byte-identical to the npm
packages under Node on the recorded corpus below.

## Use

Native daemon builds add three tsconfig `paths` entries (absolute, or relative to the build's
tsconfig):

```json
"@xterm/headless": ["<project>/native/xterm/headless.ts"],
"@xterm/addon-serialize": ["<project>/native/xterm/addon-serialize.ts"],
"@xterm/addon-unicode-graphemes": ["<project>/native/xterm/addon-unicode-graphemes.ts"]
```

No FFI manifest or build step. The build tsconfig must not set `noUnusedParameters` or
`noUnusedLocals` (upstream's code has unused parameters, and scriptc checks every file with the
entry's options); `noFallthroughCasesInSwitch` is fine.

Under the mapping, Paseo's `Terminal`, `IBuffer`, `IBufferLine`, `IBufferCell`, `IParser`,
`IBufferNamespace`, `IUnicodeHandling` and `ITerminalAddon` are the implementation classes
(`types.ts`); every other public type comes from upstream's typings.

## Layout

- `upstream/`: the vendored tree, generated. Do not edit it by hand: change `local.patch`.
- `scripts/vendor.ts`: rebuilds `upstream/` from an xterm.js clone, or checks it with `--check`.
  It copies the listed files at the pinned commits, unwraps the ambient typings into modules and
  rewrites `@xterm/*` and `common/`/`browser/` imports to relative paths, then applies
  `local.patch`. A patch that does not apply fails the run.
- `headless.ts`, `addon-serialize.ts`, `addon-unicode-graphemes.ts`: the entries the `paths` point at.
- `types.ts`: the public type names bound to implementation classes.
- `test.sh`, `tests/`: the comparison against the npm packages.

To change a local patch: edit `upstream/`, then regenerate the patch against a pristine tree
(`vendor.ts` with an empty `local.patch`, then `diff -ruN`), and run `vendor.ts <clone> --check`.

## Upstream

| Package | Version | xterm.js commit |
| --- | --- | --- |
| `@xterm/headless` | 6.1.0-beta.334 | `08829c7eb6279dda2a9e86df901353a1a89858ca` |
| `@xterm/addon-unicode-graphemes` | 0.5.0-beta.330 | `08829c7eb6279dda2a9e86df901353a1a89858ca` |
| `@xterm/addon-serialize` | 0.14.0 | `f447274f430fd22513f6adbf9862d19524471c04` |

The commits are the `commit` fields of the installed packages' `package.json`. Every source in
the headless bundle's source map (`sourcesContent`) is byte-identical to that commit, and the
serialize addon's shipped `src/SerializeAddon.ts` is identical to its commit. Type-only modules
(`*/Types.ts`, `data/EscapeSequences.ts`, the typings) are not in the source maps and come from
the same commits. The serialize addon uses `src/browser/Types.ts` and `src/common/Color.ts` from
the headless commit: between the two commits they differ only in imports, types, a `parseInt`
radix and a `transparent` keyword, none on the path the addon takes.

## Local changes (`local.patch`)

Each keeps Node behaviour except where marked as a limit below.

- Dependency injection: parameter decorators removed (scriptc compiles only standard
  decorators, SC0016), `createDecorator` constants and `InstantiationService` dropped, and
  `CoreTerminal` constructs its services directly in the same order with the same arguments.
- `VoidEmitter` and `EventUtils.forwardVoid` replace `Emitter<void>` (scriptc cannot instantiate
  a class with `void` or `undefined`).
- Internal `IBufferLine` and `ICellData` are type aliases of `BufferLine` and `CellData`, their one
  implementations (scriptc cannot instantiate `CircularList` over an interface).
  `CircularList` drops `implements ICircularList<T>`, and `IBuffer.lines` is a `CircularList`.
- Public API classes return implementation classes (`parser`, `buffer`, `unicode`,
  `buffer.active`, `getLine`, `getNullCell`) and drop `implements` of the typings.
- `loadAddon` is generic; `AddonManager` keeps a dispose closure per addon instead of replacing
  the addon's `dispose` method (scriptc cannot assign to methods).
- Options: no `Object.defineProperty` accessors. `options` is the raw options object, so reads
  are unchanged, and every write inside xterm goes through `OptionsService.setOption` (the former
  setter, with validation and change events). The public `terminal.options = {...}` setter calls
  it too.
- Parser handler tables are `Map`s instead of number-keyed objects (no `delete` with number keys
  or `??=` through an indexed receiver); missing CSI and ESC handler lists read as a shared empty
  array.
- `TaskQueue`: `IdleTaskQueue` is `PriorityTaskQueue` (what Node selects, as it has no
  `requestIdleCallback`), timer ids typed as `setTimeout` returns them, no `.bind`. `TimeoutTimer`
  uses `undefined` instead of `-1` for "no timer".
- `Platform.ts`: `isNode` is `true` and the user agent `'node'` (what upstream detects under Node).
- `Color.ts`: no canvas context (Node has no `document`, so upstream has none either); CSS
  colours other than `#hex`, `rgb()`/`rgba()` and `transparent` throw as under Node.
- Smaller rewrites: two switch fall-throughs as shared cases with a guard, chained `CHARSETS`
  assignments split, `string | Uint8Array` lengths read after narrowing, `Array.apply` and
  `push.apply` as `Array.from` and spread, tuple indexing through an array, string keys for
  `delete` on `BufferLine`'s combined and extended tables, compound assignment written out,
  `UnicodeV6`'s table read through a field, the slow-handler rejection as an `Error` compared by
  identity, `LogService` calling the console or logger method directly, `tiny-inflate` calling
  `Uint8Array.slice` without the existence check, `CoreTerminal`'s Windows wrapping line-feed
  listener as a closure instead of `.bind` (a variadic bound function conflicts with any
  zero-parameter function value passed where one parameter is expected, SC1090).
- `SerializeAddon.ts`: imports typed through `types.ts`; `IAttributeData` imported from
  `buffer/Types` (where the headless commit keeps it).

## Verified

`native/xterm/test.sh` (with `XTERM_CLONE` set, it first runs `vendor.ts --check`):

```text
native/xterm/upstream matches (63 files)
20 cases, 2669 steps -> .../.scratch/xterm/corpus.json
same  plain-wrap
...
same  vim-alt-only
20 of 20 cases identical
same  session
PASS
```

The corpus: plain text with wrapping and a pending-wrap cursor, SGR (attributes, 16, 256 and
true colour, underline styles and colour), cursor movement, save and restore, tabs, erase
(ED, EL, ECH, DCH, ICH), scroll regions with IL, DL, SU, SD and reverse index, 200 lines of
scrollback, alternate screen entered and left, modes (bracketed paste, application cursor and
keypad, mouse tracking, insert mode, hidden cursor, DECSCUSR) and titles, CJK, combining marks,
emoji ZWJ, flag and skin-tone clusters, Devanagari conjuncts, wide-character wrapping, shrink and
grow reflow, OSC 8 links, DEC line drawing, DECAWM off, and real `ls --color -la /usr/bin`,
`top -n 1`, `vim -u NONE` (edit, resize to 100x30 inside vim, quit) and `vim` killed while on the
alternate screen, recorded through node-pty. Each case compares the full replay, a 5-row-history
replay, the stripped and raw capture, cursor, buffer type and lengths, and a reconnecting
client's parse of the replay (capture, state, and its own replay equal to the original).
`session` runs one real `createTerminal` session (native pty stand-in, `/bin/sh` printing
colours, wide and combining text, 40 history lines, alternate screen, modes) and compares
`captureLines`, `hasOutput`, `serializeReplay` and its metadata.

`diff-outputs.mjs` reports a difference when one field of the native output is changed (checked
by editing a cursor position).

## Limits

- `terminal.options.x = value` (a property write on the options object) stores the value without
  validation, change event or the constructor-only check. Use `terminal.options = { x: value }`.
  Nothing in Paseo writes options.
- An addon disposed directly (`addon.dispose()`) stays registered and is disposed again when the
  terminal is disposed. Paseo never disposes addons directly.
- `SerializeAddon.serializeAsHTML({ onlySelection: true })` throws a `TypeError`, as it does
  under Node for a headless terminal.
- Not compiled or tested natively: anything outside Paseo's use, in particular `registerMarker`,
  decorations, `serializeAsHTML`, OSC 52, kitty keyboard and image protocols, async parser
  handlers, and the `logger` option.

## Not verified

- Speed. One wall-clock run on a shared machine, release build: the `ls-color` case (6000 rows,
  450 KB replay) took 6.1 s natively and 3.1 s under Node, the other 19 cases 0.75 s and 0.37 s.
  Not profiled; a dev build is about four times slower than release.
- macOS.
