#!/bin/sh
# Copies the OpenCode SDK's generated declarations into ./types/, where client.ts imports
# them. Generated, not committed: the file belongs to the SDK and must match the installed
# version. A copy outside the package, because a tsconfig `paths` entry that names a package
# makes scriptc fail on declarations imported from that package's own directory (SC9001,
# see native/claude-sdk/sync-types.sh). The Makefile's daemon-prep and test.sh run this.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sdk=$here/../../work/paseo/packages/server/node_modules/@opencode-ai/sdk/dist/v2/gen
test -f "$sdk/types.gen.d.ts" || { echo "missing $sdk/types.gen.d.ts (run make paseo-deps)" >&2; exit 1; }
mkdir -p "$here/types"
cp "$sdk/types.gen.d.ts" "$here/types/types.gen.d.ts"
