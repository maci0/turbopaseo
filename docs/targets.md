# Targets

`make list` prints the same table. Outputs go to `builds/`.

| Make target | `SCRIPTC_TARGET` | Runtime pack | Output |
| --- | --- | --- | --- |
| `linux-x64` | `x86_64-linux-gnu` | bundled with the x64 Linux compiler | `builds/paseo-linux-x64` |
| `linux-arm64` | `aarch64-linux-gnu` | `@scriptc/runtime-linux-arm64-gnu` | `builds/paseo-linux-arm64` |
| `darwin-x64` | `x86_64-apple-darwin` | `@scriptc/runtime-darwin-x64` | `builds/paseo-darwin-x64` |
| `darwin-arm64` | `aarch64-apple-darwin` | `@scriptc/runtime-darwin-arm64` | `builds/paseo-darwin-arm64` |

`make all` builds these four. The row that matches this machine uses the runtime shipped inside the scriptc install. The other three check that `work/paseo/node_modules/@scriptc/runtime-<suffix>` exists and that `zig` is on `PATH`.

```
cd work/paseo
npm install --save-dev @scriptc/runtime-linux-arm64-gnu@0.4.10
```

Use the same version as `scriptc --version`.

glibc Linux binaries need glibc 2.34 or newer. macOS binaries need macOS 14. Darwin targets can be linked from Linux with zig and the Darwin runtime pack. scriptc still needs a macOS host for iOS, and iOS is not a target here.

## Host detection

`make` with no goal builds the row whose target matches `uname`: Linux x86-64, Linux aarch64, Darwin x86-64, Darwin arm64.
