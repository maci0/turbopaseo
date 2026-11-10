# eventsource

`eventsource` 3.0.7 in the native daemon, through the package's own TypeScript sources
(`src/`, shipped in the package). Its `dist/` build is esbuild output whose WeakMap-emulated
private fields and static assignments after the class scriptc cannot run. Named
re-exports: importers did not see names that arrived through `export *`. Used by the MCP
SDK's SSE client transport. Loads natively; the transport itself is not exercised.
