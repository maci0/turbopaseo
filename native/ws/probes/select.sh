#!/usr/bin/env bash
# Can a native build swap npm `ws` for this package while Node keeps `ws`?
# Builds two throwaway fixtures under $OUT_DIR/select and prints what each
# binary (and Node, for the define fixture) reports.
#
# define: a package `fakews` whose index.js picks its exports by an env
#   variable, as a patched ws/index.js would: FAKEWS_NATIVE=1 a plain JS
#   module, =ts a JS module that requires this directory's index.ts (which
#   fails the build, SC1010, whenever it is compiled), anything else node.js.
#   A build that succeeds with =1 therefore did not compile the =ts branch.
# paths: no package; the entry's tsconfig maps `fakews` to index.ts. A JS
#   package `consumer` imports `fakews` too, as @getpaseo/* dist files import
#   `ws`. Built once without and once with an installed `fakews` package,
#   whose WebSocket.OPEN is 42 (the native class says 1).
#
#   SCRIPTC  scriptc binary (default: <project>/.scratch/scriptc-tool)
#   OUT_DIR  fixture root (default: <project>/.scratch/nativews)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$here"
while [[ "$root" != "/" && ! -e "$root/.git" ]]; do root="$(dirname "$root")"; done
[[ -e "$root/.git" ]] || { echo "select.sh: no project root above $here" >&2; exit 1; }
scriptc="${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}"
out="${OUT_DIR:-$root/.scratch/nativews}/select"
types="$here/node_modules/@types"

rm -rf "$out"
mkdir -p "$out/define/node_modules/fakews" "$out/paths/node_modules/consumer"
ln -s "$types" "$out/define/node_modules/@types"
ln -s "$types" "$out/paths/node_modules/@types"

tsconfig() { # $1 dir, $2 extra compilerOptions JSON members
  cat >"$1/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "types": ["node"], "strict": true, "skipLibCheck": true, "noEmit": true,
    "allowImportingTsExtensions": true, "allowJs": true$2
  }
}
EOF
}

build() { # $1 dir, $2 output name, rest: extra scriptc options
  local dir="$1" name="$2"
  shift 2
  (cd "$dir" && "$scriptc" build entry.ts -o "$dir/$name" --optimization dev \
    --node-islands=off "$@" 2>&1 | grep -E 'error|compiled' | head -3) || true
  if [[ -x "$dir/$name" ]]; then
    timeout 10 "$dir/$name" 2>&1 | grep -v '^    at ' || true
  fi
}

# --- define fixture -------------------------------------------------------
d="$out/define"
tsconfig "$d" ""
cat >"$d/node_modules/fakews/package.json" <<'EOF'
{ "name": "fakews", "version": "1.0.0", "main": "index.js" }
EOF
cat >"$d/node_modules/fakews/index.d.ts" <<'EOF'
export declare const which: string;
EOF
cat >"$d/node_modules/fakews/index.js" <<'EOF'
'use strict';
if (process.env.FAKEWS_NATIVE === '1') {
  module.exports = require('./native.js');
} else if (process.env.FAKEWS_NATIVE === 'ts') {
  module.exports = require('./native-ts.js');
} else {
  module.exports = require('./node.js');
}
EOF
cat >"$d/node_modules/fakews/node.js" <<'EOF'
'use strict';
const name = process.argv[2] || './missing.js';
exports.which = 'node';
exports.loaded = require(name);
EOF
cat >"$d/node_modules/fakews/native.js" <<'EOF'
'use strict';
exports.which = 'native';
EOF
cat >"$d/node_modules/fakews/native-ts.js" <<EOF
'use strict';
const native = require('$here/index.ts');
exports.which = typeof native.WebSocket === 'function' ? 'native-ts' : 'broken';
EOF
cat >"$d/node-check.cjs" <<'EOF'
'use strict';
console.log(`define (node): which=${require('fakews').which}`);
EOF
cat >"$d/entry.ts" <<'EOF'
import { which } from "fakews";
console.log(`define: which=${which}`);
EOF

echo "== define: no --define (every branch compiles)"
build "$d" plain
echo "== define: --define='process.env.FAKEWS_NATIVE=\"0\"' (node branch alone)"
build "$d" node-branch --define='process.env.FAKEWS_NATIVE="0"'
echo "== define: --define='process.env.FAKEWS_NATIVE=\"1\"' (plain JS branch)"
build "$d" native --define='process.env.FAKEWS_NATIVE="1"'
echo "== define: --define='process.env.FAKEWS_NATIVE=\"ts\"' (branch requires index.ts)"
build "$d" native-ts --define='process.env.FAKEWS_NATIVE="ts"'
echo "== define: Node, variable unset (takes the node branch; its require fails by design)"
(cd "$d" && timeout 10 node node-check.cjs 2>&1 | grep -E 'which|Cannot find' | head -2) || true

# --- paths fixture --------------------------------------------------------
p="$out/paths"
tsconfig "$p" ",
    \"paths\": { \"fakews\": [\"$here/index.ts\"] }"
cat >"$p/node_modules/consumer/package.json" <<'EOF'
{ "name": "consumer", "version": "1.0.0", "main": "index.js" }
EOF
cat >"$p/node_modules/consumer/index.d.ts" <<'EOF'
export declare const consumerSees: string;
EOF
cat >"$p/node_modules/consumer/index.js" <<'EOF'
'use strict';
const fakews = require('fakews');
exports.consumerSees = typeof fakews.WebSocket === 'function' ? 'native WebSocket' : 'the installed package';
EOF
cat >"$p/entry.ts" <<'EOF'
import { WebSocket } from "fakews";
import { consumerSees } from "consumer";
console.log(`paths: entry WebSocket.OPEN=${WebSocket.OPEN}`);
console.log(`paths: consumer sees ${consumerSees}`);
EOF

echo "== paths: no fakews package installed"
build "$p" no-package

mkdir -p "$p/node_modules/fakews"
cat >"$p/node_modules/fakews/package.json" <<'EOF'
{ "name": "fakews", "version": "1.0.0", "main": "index.js" }
EOF
cat >"$p/node_modules/fakews/index.d.ts" <<'EOF'
export declare const WebSocket: { OPEN: number };
EOF
cat >"$p/node_modules/fakews/index.js" <<'EOF'
'use strict';
exports.WebSocket = { OPEN: 42 };
EOF
echo "== paths: fakews package installed"
build "$p" with-package
