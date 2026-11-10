// Native build entry for `@getpaseo/highlight`: the package's TypeScript source, reached
// through the `paseo-src` symlink. scriptc 0.4.10 compiles a workspace package from its
// dist JavaScript, whose untyped generators it cannot drive (`Generator.next` has no
// lowering there), and a `paths` entry that names a file inside the package's own directory
// fails with SC1090 "binding form with no lowering"; the symlinked path avoids both.
export * from "./paseo-src/index.js";
