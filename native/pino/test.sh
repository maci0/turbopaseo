#!/bin/sh
# Builds tests/log-probe.ts natively against this stand-in and compares its output with the
# same program under Node with npm pino and pino-pretty, in four modes: json or pretty, to
# stdout or to a file. Exits nonzero on any build failure, crash, timeout or differing line.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$here
while [ ! -f "$root/.gitmodules" ] || [ ! -d "$root/native" ]; do
  [ "$root" = / ] && { echo "cannot find the turbopaseo root" >&2; exit 2; }
  root=$(dirname "$root")
done
SCRIPTC=${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}
OUT_DIR=${OUT_DIR:-$root/.scratch/nativepino}
server=$root/work/paseo/packages/server
probe=$server/zzprobe-pino-test
RUN_TIMEOUT=30
BUILD_TIMEOUT=600

mkdir -p "$OUT_DIR"
rm -rf "$probe"
mkdir "$probe"
trap 'rm -rf "$probe"' EXIT
cp "$here/tests/log-probe.ts" "$probe/"
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
      "pino": ["$here/index.ts"],
      "pino-pretty": ["$here/pretty.ts"]
    }
  },
  "include": ["*.ts"]
}
JSON

(cd "$probe" && timeout "$BUILD_TIMEOUT" "$SCRIPTC" build log-probe.ts -o "$OUT_DIR/log-probe" \
  --optimization dev --node-islands=off > "$OUT_DIR/build.out" 2> "$OUT_DIR/build.err")
build_status=$?
if [ "$build_status" -ne 0 ]; then
  echo "native build failed ($build_status), see $OUT_DIR/build.err" >&2
  exit 1
fi

status=0
compare() {
  (cd "$server" && timeout "$RUN_TIMEOUT" node --import tsx "$here/tests/compare.ts" "$1" "$2") || status=1
}
for format in json pretty; do
  for target in stdout file; do
    for runner in node native; do
      out=$OUT_DIR/$runner-$format-$target
      rm -f "$out.log"
      if [ "$runner" = node ]; then
        # The probe tsconfig maps pino to the stand-in; Node must resolve npm pino.
        (cd "$probe" && TSX_TSCONFIG_PATH=../tsconfig.json timeout "$RUN_TIMEOUT" \
          node --import tsx log-probe.ts "$format" "$target" "$out.log" > "$out.txt" 2> "$out.err")
      else
        (cd "$probe" && timeout "$RUN_TIMEOUT" "$OUT_DIR/log-probe" "$format" "$target" "$out.log" \
          > "$out.txt" 2> "$out.err")
      fi
      run_status=$?
      if [ "$run_status" -ne 0 ]; then
        echo "$runner $format $target exited $run_status, see $out.err" >&2
        status=1
      fi
    done
    compare "$OUT_DIR/node-$format-$target.txt" "$OUT_DIR/native-$format-$target.txt"
    if [ "$target" = file ]; then
      compare "$OUT_DIR/node-$format-$target.log" "$OUT_DIR/native-$format-$target.log"
    fi
  done
done
if [ "$status" -eq 0 ]; then echo PASS; else echo FAIL; fi
exit "$status"
