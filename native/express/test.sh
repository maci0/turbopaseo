#!/usr/bin/env bash
# Typechecks express.ts, builds tests/server.ts natively, generates the real
# express twin of tests/server.ts, creates the fixtures, and runs
# tests/compare.ts. Exits nonzero on a build failure or on any difference
# that README.md does not list as intentional.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$here
while [ ! -f "$root/.gitmodules" ]; do
  if [ "$root" = / ]; then
    echo "test.sh: no .gitmodules above $here" >&2
    exit 2
  fi
  root=$(dirname "$root")
done
out=$root/.scratch/nativeexpress
scriptc=$root/.scratch/scriptc-tool/node_modules/.bin/scriptc
paseo_modules=$root/work/paseo/node_modules
mkdir -p "$out/tmp"
# tsx caches transpiled files under the temp directory; keep them off /tmp.
export TMPDIR=$out/tmp

if [ ! -e "$here/node_modules" ]; then
  ln -s "$paseo_modules" "$here/node_modules"
fi
tsx=$here/node_modules/.bin/tsx

echo "== typecheck"
(cd "$here" && timeout 120 node_modules/.bin/tsc -p .)

echo "== native build"
(cd "$here" && timeout 600 "$scriptc" build tests/server.ts -o "$out/server-native" \
  --optimization dev --node-islands=off > "$out/build.log" 2>&1) || {
  cat "$out/build.log"
  exit 1
}

echo "== real express twin"
gen=$out/gen
mkdir -p "$gen"
ln -sfn "$paseo_modules" "$gen/node_modules"
# The module's API differs from express only in `res.raw`, the node:http
# response that an IncomingMessage is piped into natively.
sed -e 's#from "../express.js"#from "express"#' \
  -e 's/res\.raw\b/res/g' \
  "$here/tests/server.ts" > "$gen/server-express.ts"
if rg -q '\.raw\b' "$gen/server-express.ts"; then
  echo "test.sh: the express twin still uses module-only API" >&2
  exit 1
fi

echo "== fixtures"
fx=$out/fixtures
rm -rf "$fx"
mkdir -p "$fx/public/sub" "$fx/public/.dir" "$fx/ui"
printf 'hello\n' > "$fx/public/hello.txt"
printf '<!doctype html><title>public</title>\n' > "$fx/public/index.html"
printf 'console.log("public");\n' > "$fx/public/app.js"
printf '<svg xmlns="http://www.w3.org/2000/svg"/>\n' > "$fx/public/logo.svg"
printf 'readme\n' > "$fx/public/README"
printf 'spaced\n' > "$fx/public/with space.txt"
printf 'odd\n' > "$fx/public/odd.constructor"
printf 'body{}\n' > "$fx/public/sub/a.css"
printf 'hidden\n' > "$fx/public/.hidden"
printf 'in dot dir\n' > "$fx/public/.dir/file.txt"
printf 'top secret\n' > "$fx/secret.txt"
ln -s ../secret.txt "$fx/public/link-out"
ln -s hello.txt "$fx/public/link-in"
printf '<!doctype html><html><head><title>ui</title></head><body></body></html>\n' > "$fx/ui/index.html"
printf 'console.log("ui");\n' > "$fx/ui/app.js"
head -c 200000 /dev/zero | tr '\0' 'd' > "$fx/download.bin"
find "$fx" -exec touch -h -d '2024-01-02 03:04:05 UTC' {} +

echo "== compare"
cd "$here"
PROBE_README=$here/README.md \
PROBE_EXPRESS_SERVER=$gen/server-express.ts \
PROBE_MODULE_SERVER=$here/tests/server.ts \
PROBE_NATIVE_SERVER=$out/server-native \
PROBE_STATIC_DIR=$fx/public \
PROBE_UI_DIR=$fx/ui \
PROBE_DOWNLOAD_FILE=$fx/download.bin \
  timeout 300 "$tsx" tests/compare.ts
