#!/bin/sh
# Builds tests/highlight-proof.ts and tests/diff-probe.ts natively against this stand-in and
# compares their output with the same programs under Node with the real packages: every token
# of every file in tests/samples, and the server's highlighted diff of a scratch git repo,
# which must also parse as a protocol `checkout_diff_update`. Exits nonzero on any build
# failure, crash, timeout or difference.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$here
while [ ! -f "$root/.gitmodules" ] || [ ! -d "$root/native" ]; do
  [ "$root" = / ] && { echo "cannot find the turbopaseo root" >&2; exit 2; }
  root=$(dirname "$root")
done
SCRIPTC=${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}
OUT_DIR=${OUT_DIR:-$root/.scratch/nativehighlight}
server=$root/work/paseo/packages/server
probe=$server/zzprobe-highlight-test
RUN_TIMEOUT=60
BUILD_TIMEOUT=900

mkdir -p "$OUT_DIR"
rm -rf "$probe"
mkdir "$probe"
trap 'rm -rf "$probe"' EXIT
status=0

build() {
  (cd "$1" && timeout "$BUILD_TIMEOUT" "$SCRIPTC" build "$2" -o "$OUT_DIR/$3" \
    --optimization dev --node-islands=off > "$OUT_DIR/$3.build" 2>&1) || {
    echo "native build of $2 failed, see $OUT_DIR/$3.build" >&2
    exit 1
  }
}

same() {
  if cmp -s "$1" "$2"; then echo "same: $3"; else echo "DIFFERENT: $3 ($1 $2)" >&2; status=1; fi
}

# 1. Tokens: highlightCode and highlightCodeWithBudget for every sample.
build "$here/tests" highlight-proof.ts highlight-proof
(cd "$here/tests" && timeout "$RUN_TIMEOUT" node highlight-proof.ts samples/* \
  > "$OUT_DIR/tokens-node.txt" 2> "$OUT_DIR/tokens-node.err") || { echo "node proof failed" >&2; status=1; }
(cd "$here/tests" && timeout "$RUN_TIMEOUT" "$OUT_DIR/highlight-proof" samples/* \
  > "$OUT_DIR/tokens-native.txt" 2> "$OUT_DIR/tokens-native.err") || { echo "native proof failed" >&2; status=1; }
same "$OUT_DIR/tokens-node.txt" "$OUT_DIR/tokens-native.txt" "tokens of $(ls "$here/tests/samples" | wc -l) samples"

# 2. The server's diff highlighter on a repo with edits in several languages.
repo=$OUT_DIR/repo
rm -rf "$repo"
mkdir -p "$repo"
cp "$here"/tests/samples/sample.ts "$here"/tests/samples/sample.swift "$here"/tests/samples/sample.py \
  "$here"/tests/samples/sample.md "$here"/tests/samples/sample.vue "$here"/tests/samples/sample.dart "$repo/"
(cd "$repo" && git init -q && git add . && git -c user.name=probe -c user.email=probe@localhost commit -qm base \
  && sed -i 's/Point/Coord/g' sample.ts && sed -i 's/greet/welcome/' sample.swift \
  && printf 'let extra = "added"\n' >> sample.swift && sed -i '3d' sample.py \
  && printf '\n## New section\n\nMore *text*.\n' >> sample.md && sed -i 's/message/msg/' sample.vue \
  && sed -i 's/count/total/' sample.dart && printf 'plain\n' > notes.txt && git add -N notes.txt \
  && git diff > "$OUT_DIR/repo.diff") || { echo "could not make the test repo" >&2; exit 1; }
cp "$here/tests/diff-probe.ts" "$here/tests/diff-validate.ts" "$probe/"
cat > "$probe/tsconfig.json" <<JSON
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "rootDir": "$root",
    "baseUrl": ".",
    "paths": {
      "@server/*": ["../src/*"],
      "@codemirror/language": ["$here/language.ts"],
      "@getpaseo/highlight": ["$here/index.ts"]
    }
  },
  "include": ["*.ts"]
}
JSON
build "$probe" diff-probe.ts diff-probe
(cd "$probe" && TSX_TSCONFIG_PATH=../tsconfig.json timeout "$RUN_TIMEOUT" node --import tsx diff-probe.ts \
  "$OUT_DIR/repo.diff" "$repo" > "$OUT_DIR/diff-node.json" 2> "$OUT_DIR/diff-node.err") \
  || { echo "node diff probe failed" >&2; status=1; }
(cd "$probe" && timeout "$RUN_TIMEOUT" "$OUT_DIR/diff-probe" "$OUT_DIR/repo.diff" "$repo" \
  > "$OUT_DIR/diff-native.json" 2> "$OUT_DIR/diff-native.err") || { echo "native diff probe failed" >&2; status=1; }
same "$OUT_DIR/diff-node.json" "$OUT_DIR/diff-native.json" "highlighted diff"
(cd "$probe" && TSX_TSCONFIG_PATH=../tsconfig.json timeout "$RUN_TIMEOUT" node --import tsx diff-validate.ts \
  "$OUT_DIR/diff-native.json") || status=1

if [ "$status" -eq 0 ]; then echo PASS; else echo FAIL; fi
exit "$status"
