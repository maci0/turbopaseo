// Native entry for the Paseo daemon. It exists so scriptc reads the
// tsconfig.json beside it, whose `paths` swap in the native stand-ins.
import "../scripts/supervisor-entrypoint.js";

// Never taken. scriptc compiles an npm package only when the entry's own module
// graph reaches it; a module reached only as a fork() target fails with SC2013
// ("its implementation is not part of the compiled module graph"). Naming each
// forked module here puts its packages into the program. `void`, not `await`:
// a top-level await makes this module async, and scriptc then initialises the
// imported modules on a 512 KiB fiber stack, which the protocol's zod schemas
// overflow.
if (process.env.PASEO_NATIVE_GRAPH_ONLY === "never-set") {
  void import("../src/server/daemon-worker.ts");
  void import("../src/terminal/terminal-worker-native-process.ts");
  void import("./speech-worker.ts");
}
