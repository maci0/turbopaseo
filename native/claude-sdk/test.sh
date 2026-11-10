#!/usr/bin/env bash
# Runs tests/scenarios.ts three times and requires identical output:
#   sdk     the real @anthropic-ai/claude-agent-sdk under Node (the reference)
#   node    this module under Node
#   native  this module built with scriptc (the fake CLI stays a Node script)
# Every query scenario talks to tests/fake-claude.ts; no real CLI or API is used.
#
# The native run builds tests/run-sdk.ts, which imports the package by name: tsconfig.json
# maps it to index.ts with `paths`, as the daemon build does, so the scenarios and index.ts
# see one set of SDK declarations (types/, from sync-types.sh).
#
#   SCRIPTC   scriptc binary (default: <project>/.scratch/scriptc-tool/node_modules/.bin/scriptc)
#   OUT_DIR   logs and the native build (default: <project>/.scratch/claude-sdk/test)
#   RUNS      space-separated subset of "sdk node native"
#   SCENARIO  run only this query scenario (and no forkSession cases)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [[ "$root" != "/" && ! -e "$root/.git" ]]; do root="$(dirname "$root")"; done
[[ -e "$root/.git" ]] || { echo "test.sh: no project root above $here" >&2; exit 1; }

scriptc="${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}"
out="${OUT_DIR:-$root/.scratch/claude-sdk/test}"
runs="${RUNS:-sdk node native}"
scenario="${SCENARIO:-}"
run_timeout_s=300

[[ -e "$here/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts" ]] || {
  echo "test.sh: $here/node_modules missing; link it to work/paseo/node_modules" >&2
  exit 1
}
"$here/sync-types.sh"
"$here/node_modules/.bin/tsc" -p "$here"

files=(queries.txt)
[[ -n "$scenario" ]] || files+=(forks.txt)

mkdir -p "$out/bin"
export TMPDIR="$out"
cd "$here"

for run in $runs; do
  rm -rf "${out:?}/$run"
  mkdir -p "$out/$run"
  case "$run" in
    sdk) command=(node tests/run-sdk.ts) ;;
    node) command=(node tests/run-native.ts) ;;
    native)
      "$scriptc" build tests/run-sdk.ts -o "$out/bin/run-sdk" --optimization dev \
        --node-islands=off >"$out/bin/build.log" 2>&1 || { cat "$out/bin/build.log" >&2; exit 1; }
      rm -f "$out/bin/run-sdk.ll"
      command=("$out/bin/run-sdk")
      ;;
    *) echo "test.sh: unknown run $run" >&2; exit 1 ;;
  esac
  command+=("$out/$run")
  [[ -z "$scenario" ]] || command+=("$scenario")
  set +e
  timeout --kill-after=5 "$run_timeout_s" "${command[@]}" 2>"$out/$run.stderr"
  status=$?
  set -e
  [[ $status -eq 0 ]] || { cat "$out/$run.stderr" >&2; echo "FAIL: $run exited $status" >&2; exit 1; }
  counts=""
  for file in "${files[@]}"; do
    case "$file" in queries.txt) label=query ;; forks.txt) label=fork ;; esac
    counts+=" $(wc -l <"$out/$run/$file") $label lines,"
  done
  echo "$run:${counts%,}"
done

failures=0
reference="${runs%% *}"
for run in $runs; do
  [[ "$run" == "$reference" ]] && continue
  for file in "${files[@]}"; do
    diff -u "$out/$reference/$file" "$out/$run/$file" >"$out/$run.$file.diff" ||
      { cat "$out/$run.$file.diff" >&2; echo "FAIL: $run $file differs from $reference" >&2; failures=$((failures + 1)); }
  done
done
[[ $failures -eq 0 ]] || exit 1
echo PASS
