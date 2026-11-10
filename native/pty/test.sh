#!/usr/bin/env bash
# Build libpty.a and the demo binary, run it under a timeout, and check every
# observation it prints. Exits non-zero on any mismatch, crash, or wedge.
#
#   SCRIPTC  scriptc binary (default: scriptc on PATH)
#   OUT_DIR  where the binary goes (default: <project>/.scratch/pty)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [[ "$root" != "/" && ! -e "$root/.git" ]]; do root="$(dirname "$root")"; done
[[ -e "$root/.git" ]] || { echo "test.sh: no project root above $here" >&2; exit 1; }

scriptc="${SCRIPTC:-scriptc}"
out_dir="${OUT_DIR:-$root/.scratch/pty}"
run_timeout_s=60
mkdir -p "$out_dir"

"$here/build.sh"
# scriptc keeps its LLVM helper per working directory, so build from here.
(cd "$here" && "$scriptc" build demo.ts --ffi ffi.json -o "$out_dir/demo" --node-islands=off)

set +e
output="$(cd "$out_dir" && timeout --kill-after=5 "$run_timeout_s" "$out_dir/demo")"
status=$?
set -e
printf '%s\n' "$output"
if [[ $status -ne 0 ]]; then
  echo "FAIL: demo exited with status $status (124 = wedged past ${run_timeout_s}s)" >&2
  exit 1
fi

failures=0
expect() {
  local line="$1"
  if ! grep -qxF -- "$line" <<<"$output"; then
    echo "FAIL: missing line: $line" >&2
    failures=$((failures + 1))
  fi
}

expect 'hello.output="hello"'
expect 'hello.exit={"exitCode":3}'
expect 'cat.output="ping\r\nping\r\n"'
expect 'cat.exit={"exitCode":0}'
expect 'bigInput.count="200000"'
expect 'bigInput.exit={"exitCode":0}'
expect 'stty.output="go\r\n50 132\r\n"'
expect 'stty.exit={"exitCode":0}'
expect 'kill.exit={"exitCode":0,"signal":15}'
expect 'kill.fast=true'
expect 'kill.reaped=true'
expect 'hup.exit={"exitCode":0,"signal":1}'
expect 'big.length=200000'
expect 'big.allA=true'
expect 'big.exit={"exitCode":0}'
expect 'utf8.length=30000'
expect 'utf8.clean=true'
expect 'background.output="bg"'
expect 'background.exit={"exitCode":4}'
expect 'background.fast=true'
expect "env.output=\"xterm-256color|$out_dir\""
expect 'holder.exit={"exitCode":0,"signal":9}'
expect 'mixed.childProcessCode=6'
expect 'mixed.exit={"exitCode":5}'
expect 'late.exit={"exitCode":0}'
expect 'late.error="none"'
expect 'missing.error="pty spawn /nonexistent/binary failed: No such file or directory (errno 2)"'
expect 'badcwd.error="pty spawn /bin/sh failed: No such file or directory (errno 2)"'
if [[ "$(uname -s)" == Linux ]]; then
  expect 'signals.output="SigBlk:\t0000000000000000\r\nSigIgn:\t0000000000000000\r\n"'
  expect 'fds.output="0 1 2 3 "'
fi
expect 'reuse.ok=260'
expect 'reuse.fdDelta=0'
expect 'DONE'

if [[ $failures -ne 0 ]]; then
  echo "FAIL: $failures check(s)" >&2
  exit 1
fi
echo "PASS"
