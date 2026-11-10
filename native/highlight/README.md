# native/highlight

Syntax highlighting for scriptc builds of Paseo's daemon. The daemon highlights diffs with
`@getpaseo/highlight` (`packages/highlight`); natively it runs that package's own TypeScript
source, with `@codemirror/language` replaced by `language.ts`. Tokens match Node's exactly for
every supported language. Node builds keep the real packages.

| File | Role |
| --- | --- |
| `index.ts` | replaces `@getpaseo/highlight`: re-exports `paseo-src/index.js` |
| `language.ts` | replaces `@codemirror/language` 6.12.4: `Language`, `LRLanguage`, `StreamLanguage` (a port of its stream parser), `defineLanguageFacet`, `indentNodeProp`, `foldNodeProp`, `languageDataProp`, `StringStream`, and the types the legacy modes import |
| `test.sh` | builds `tests/highlight-proof.ts` and `tests/diff-probe.ts` natively, compares both with Node, and validates the native diff with the protocol schema |
| `tests/samples/` | one or more sources per supported extension group (24 parsers), plus empty, blank-line and unsupported files |

`node_modules` is a symlink to `work/paseo/node_modules` and `paseo-src` a symlink to
`work/paseo/packages/highlight/src`. Create them with
`ln -s ../../work/paseo/node_modules native/highlight/node_modules` and
`ln -s ../../work/paseo/packages/highlight/src native/highlight/paseo-src`.

## Build

The daemon entry's tsconfig needs:

```json
"@codemirror/language": ["../../../../../native/highlight/language.ts"],
"@getpaseo/highlight": ["../../../../../native/highlight/index.ts"]
```

and the work tree needs `patches/@lezer+lr+1.4.8.patch` and
`patches/@codemirror+legacy-modes+6.5.3.patch` (both Node-neutral).

## Why each piece

- `@codemirror/language` imports `@codemirror/view` and `@codemirror/state` at load, and
  scriptc 0.4.10 fails on both with 8 `SC9001` internal errors (`varRef "%g.<module>.language"
  type object != binding dyn` at module-level facets and state effects: `language`,
  `foldConfig`, `keymap`, `openDialogEffect`, `closeDialogEffect`). The highlighter needs none
  of it: `Language` only carries a Lezer parser, `LRLanguage.define` only adds node props, and
  `highlightTree` comes from `@lezer/highlight`. Swift and Dart use `StreamLanguage`, which
  `language.ts` ports with the editor branches removed (outside an editor `ParseContext.get()`
  is always null, so tab size 4, indent unit 2, start state indent unit 4 are the constants
  the real code uses there).
- `@getpaseo/highlight` from its `dist` JavaScript does not run natively: the untyped
  generators throw `'Generator<...>.next' ... has no scriptc lowering yet [SC2020]`. A tsconfig
  `paths` entry that names a file inside `packages/highlight` breaks lowering (`SC1090 the
  reference to 'highlightCode' (a binding form with no lowering)`); reaching the same files
  through the `paseo-src` symlink works.
- `language.ts` gives `TokenTable` a `resolveTag` method, not `resolve`: any typed class
  method named `resolve` in the program makes scriptc fail with `SC9001 duplicate function
  "%prototype.data.<@lezer/common>.TreeNode"`.

## Limits

Editor-only exports throw when called: `HighlightStyle.define` (so
`createCodeMirrorHighlightStyle`) and `foldInside` throw, and `continuedIndent` and
`delimitedIndent` return strategies that throw. Nothing in the daemon calls them; the app uses
the real package. `StreamLanguage.define` takes `StreamParser<unknown>` (both legacy modes are typed
that way) rather than being generic, because scriptc cannot instantiate `NodeProp<unknown>`;
the saved parser state rides in a `SavedState` box.

## Verified

`./test.sh` (from the turbopaseo root layout; outputs in `.scratch/nativehighlight/`):
`same: tokens of 30 samples`, `same: highlighted diff`, `valid checkout_diff_update`, `PASS`.
The highlighted diff covers TypeScript, Swift, Python, Markdown, Vue, Dart and an
unsupported file. Larger real files (about 10 to 40 KB each of TypeScript, Markdown, JSON,
JavaScript, Swift, Dart and Python) were also compared once by hand with identical output.
