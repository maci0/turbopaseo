// Native entry for the Paseo CLI. It exists so scriptc reads the tsconfig.json
// beside it, whose `paths` swap in the native stand-ins; Paseo's own
// packages/cli/tsconfig.json stays as upstream wrote it.
import "../src/index.js";
