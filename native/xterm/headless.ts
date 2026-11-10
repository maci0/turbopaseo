// Native stand-in entry for `@xterm/headless`: the package's own TypeScript sources, compiled as
// part of the program. The npm package ships only a webpack bundle, which scriptc does not compile.
import { Terminal } from "./upstream/src/headless/public/Terminal";

export { Terminal };
export type * from "./types";

// Paseo imports the CommonJS package through its default export.
export default { Terminal };
