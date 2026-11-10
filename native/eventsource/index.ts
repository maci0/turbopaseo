// `eventsource` in the native daemon: the package's own TypeScript sources (it ships src/).
// Its dist/ build is esbuild output whose WeakMap-emulated private fields and static
// assignments after the class scriptc cannot run. Named re-exports: importers do not see
// names that arrive through `export *`.
export { ErrorEvent } from "../../work/paseo/node_modules/eventsource/src/errors.js";
export { EventSource } from "../../work/paseo/node_modules/eventsource/src/EventSource.js";
export type * from "../../work/paseo/node_modules/eventsource/src/types.js";
