#!/usr/bin/env bash
# Proves the vendored xterm matches the npm packages: records a corpus (real programs through
# node-pty plus hand-written escape sequences), replays it through Paseo's headless-terminal.ts,
# terminal-serializer.ts and terminal-capture.ts under Node (npm @xterm packages) and as a native
# binary (vendored sources), and compares every case field by field. Then runs one real Paseo
# terminal session (createTerminal, pty, replay, capture) both ways and compares the output.
# Every process runs under `timeout`; exits nonzero on any difference.
#
#   SCRIPTC  scriptc binary (default: <project>/.scratch/scriptc-tool)
#   OUT_DIR  corpus, builds, outputs (default: <project>/.scratch/xterm)
#   XTERM_CLONE  an xterm.js clone; when set, also checks upstream/ against it (vendor.ts --check)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [[ "$root" != "/" && ! -e "$root/.git" ]]; do root="$(dirname "$root")"; done
[[ -e "$root/.git" ]] || { echo "test.sh: no project root above $here" >&2; exit 1; }

scriptc="${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}"
out="${OUT_DIR:-$root/.scratch/xterm}"
server="$root/work/paseo/packages/server"
tsx="$root/work/paseo/node_modules/.bin/tsx"
probe="$server/zzprobe-xterm"
build_timeout_s=900
run_timeout_s=120

[[ -x "$tsx" ]] || { echo "test.sh: $tsx missing; install work/paseo" >&2; exit 1; }
[[ ! -e "$probe" ]] || { echo "test.sh: $probe exists; remove it first" >&2; exit 1; }
mkdir -p "$out/home" "$out/cwd"
trap 'rm -rf "$probe"' EXIT

if [[ -n "${XTERM_CLONE:-}" ]]; then
  timeout "$run_timeout_s" bun "$here/scripts/vendor.ts" "$XTERM_CLONE" --check
fi

# The native program sees the vendored packages and the pty stand-in; Node sees the npm packages.
mkdir -p "$probe/node"
cat > "$probe/tsconfig.json" <<EOF
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "rootDir": "../../../..",
    "paths": {
      "@xterm/headless": ["$here/headless.ts"],
      "@xterm/addon-serialize": ["$here/addon-serialize.ts"],
      "@xterm/addon-unicode-graphemes": ["$here/addon-unicode-graphemes.ts"],
      "node-pty": ["$root/native/pty/pty.ts"]
    }
  },
  "include": ["*.ts"]
}
EOF
cat > "$probe/node/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "noUnusedLocals": false, "noUnusedParameters": false, "rootDir": "../../../.." },
  "include": ["*.ts"]
}
EOF
for harness in replay-compare session-compare; do
  cp "$here/tests/$harness.ts" "$probe/"
  sed 's#"\.\./src/#"../../src/#' "$here/tests/$harness.ts" > "$probe/node/$harness.ts"
  (cd "$probe" && timeout "$build_timeout_s" "$scriptc" build "$harness.ts" -o "$out/$harness.bin" \
    --optimization dev --node-islands=off --ffi "$root/native/pty/ffi.json" > "$out/$harness.build.log" 2>&1) \
    || { echo "FAIL: native build of $harness (see $out/$harness.build.log)" >&2; exit 1; }
done

timeout "$run_timeout_s" node "$here/tests/record-corpus.mjs" "$server" "$out" "$out/corpus.json"
(cd "$probe/node" && timeout "$run_timeout_s" "$tsx" replay-compare.ts "$out/corpus.json") > "$out/replay.node.jsonl"
timeout "$run_timeout_s" "$out/replay-compare.bin" "$out/corpus.json" > "$out/replay.native.jsonl"
failures=0
node "$here/tests/diff-outputs.mjs" "$out/replay.node.jsonl" "$out/replay.native.jsonl" || failures=$((failures + 1))

(cd "$probe/node" && timeout "$run_timeout_s" "$tsx" session-compare.ts "$out/cwd") > "$out/session.node.json"
timeout "$run_timeout_s" "$out/session-compare.bin" "$out/cwd" > "$out/session.native.json"
if cmp -s "$out/session.node.json" "$out/session.native.json"; then
  echo "same  session"
else
  echo "DIFF  session: $out/session.node.json $out/session.native.json"
  failures=$((failures + 1))
fi

[[ "$failures" -eq 0 ]] || { echo "FAIL: $failures comparison(s) differ" >&2; exit 1; }
echo "PASS"
