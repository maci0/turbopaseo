#!/bin/sh
# Parity test: tests/scenario.ts through the real OpenCode SDK (Bun) and through client.ts
# (a native scriptc build), both against tests/fake-server.ts; the outputs must be identical.
# Never contacts a real OpenCode server. Outputs go to <project>/.scratch/opencode-sdk-test.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
scriptc=${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}
out=$root/.scratch/opencode-sdk-test
mkdir -p "$out"
"$here/sync-types.sh"
"$here/node_modules/.bin/tsc" -p "$here"
(cd "$here/tests" && "$scriptc" build scenario.ts -o "$out/scenario" --optimization dev --node-islands=off)
rm -f "$out/port"
bun "$here/tests/fake-server.ts" > "$out/port" &
server=$!
trap 'kill "$server" 2>/dev/null' EXIT
i=0; until [ -s "$out/port" ]; do i=$((i+1)); [ $i -gt 50 ] && { echo "fake server did not start" >&2; exit 1; }; sleep 0.1; done
port=$(cat "$out/port")
(cd "$here/tests" && timeout 60 bun --tsconfig-override=tsconfig.real.json scenario.ts "$port") > "$out/real.out"
timeout 60 "$out/scenario" "$port" 2>"$out/native.err" | grep -v '^scriptc: ' > "$out/native.out" || true
if cmp -s "$out/real.out" "$out/native.out"; then
  echo "identical: $(wc -l < "$out/real.out") results"
else
  diff "$out/real.out" "$out/native.out" | cut -c1-400
  exit 1
fi
