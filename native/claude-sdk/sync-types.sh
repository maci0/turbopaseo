#!/bin/sh
# Copies the Claude agent SDK's declaration files into ./types/, where index.ts imports them.
#
# When the tsconfig `paths` entry for @anthropic-ai/claude-agent-sdk points at index.ts,
# scriptc rejects index.ts if it imports declarations from that package's own directory
# (SC9001 "union ...: arm 0 is generator", or SC1090 on SDK-typed class fields). The same
# declarations copied outside the package compile. The copy is generated, not committed: the
# files belong to the SDK and must match the installed version. test.sh runs this.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
sdk=$here/node_modules/@anthropic-ai/claude-agent-sdk
test -f "$sdk/sdk.d.ts" || { echo "missing $sdk/sdk.d.ts (is node_modules linked?)" >&2; exit 1; }
mkdir -p "$here/types"
for f in sdk.d.ts sdk-tools.d.ts agentSdkTypes.d.ts; do
  cp "$sdk/$f" "$here/types/$f"
done
