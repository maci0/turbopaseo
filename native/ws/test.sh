#!/usr/bin/env bash
# Builds the native test programs and runs the client scenarios in four
# pairings, comparing each client and server log with tests/expected/:
#   ws-ws          npm ws server, npm ws client (the reference)
#   ws-native      npm ws server, native client
#   native-ws      native server, npm ws client
#   native-native  native server, native client
# npm ws runs under Node through tsx. Before the pairings it runs the native
# probes/http-upgrade and tests/smoke. Exits nonzero on any mismatch, crash,
# or timeout; every process runs under `timeout`.
#
#   SCRIPTC          scriptc binary (default: <project>/.scratch/scriptc-tool)
#   OUT_DIR          builds, certificates, logs (default: <project>/.scratch/nativews)
#   UPDATE_EXPECTED  1 rewrites tests/expected/ from the ws-ws pairing
#   PAIRINGS         space-separated subset of the pairings above
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [[ "$root" != "/" && ! -e "$root/.git" ]]; do root="$(dirname "$root")"; done
[[ -e "$root/.git" ]] || { echo "test.sh: no project root above $here" >&2; exit 1; }

scriptc="${SCRIPTC:-$root/.scratch/scriptc-tool/node_modules/.bin/scriptc}"
out="${OUT_DIR:-$root/.scratch/nativews}"
tsx="$here/node_modules/.bin/tsx"
pairings="${PAIRINGS:-ws-ws ws-native native-ws native-native}"
run_timeout_s=120
endpoint_wait_tenths=200

[[ -x "$tsx" ]] || {
  echo "test.sh: $tsx missing; link node_modules to work/paseo/node_modules" >&2
  exit 1
}
mkdir -p "$out/bin" "$out/logs" "$out/certs"

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

build() {
  local source="$1" name="$2"
  # scriptc keeps its LLVM helper per working directory, so build from here.
  if ! (cd "$here" && "$scriptc" build "$source" -o "$out/bin/$name" \
    --optimization dev --node-islands=off >"$out/bin/$name.build.log" 2>&1); then
    cat "$out/bin/$name.build.log" >&2
    echo "FAIL: build $source" >&2
    exit 1
  fi
}

if [[ ! -s "$out/certs/cert.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
    -keyout "$out/certs/key.pem" -out "$out/certs/cert.pem" >/dev/null 2>&1
fi

build probes/http-upgrade.ts http-upgrade
build tests/smoke.ts smoke
build tests/client-native.ts client-native
build tests/peer-native.ts peer-native

set +e
upgrade_output="$(timeout --kill-after=5 10 "$out/bin/http-upgrade")"
upgrade_status=$?
smoke_output="$(timeout --kill-after=5 10 "$out/bin/smoke")"
smoke_status=$?
set -e
[[ $upgrade_status -eq 0 ]] || fail "http-upgrade probe exited $upgrade_status"
grep -qxF "RESULT upgrade works" <<<"$upgrade_output" || fail "http-upgrade: no RESULT line"
grep -qxF 'upgrade event: /ws head="EXTRA"' <<<"$upgrade_output" || fail "http-upgrade: head lost"
grep -qxF "request event: GET /plain" <<<"$upgrade_output" || fail "http-upgrade: plain request lost"
[[ $smoke_status -eq 0 ]] || fail "smoke exited $smoke_status"
grep -qxF "client close 4000 done" <<<"$smoke_output" || fail "smoke: no client close"
grep -qxF "server close 4000 done" <<<"$smoke_output" || fail "smoke: no server close"

peer_command() {
  case "$1" in
    ws) echo "$tsx $here/tests/peer-ws.ts" ;;
    native) echo "$out/bin/peer-native" ;;
  esac
}

client_command() {
  case "$1" in
    ws) echo "$tsx $here/tests/client-ws.ts" ;;
    native) echo "$out/bin/client-native" ;;
  esac
}

run_pairing() {
  local pairing="$1"
  local peer_kind="${pairing%-*}" client_kind="${pairing#*-}"
  local logs="$out/logs/$pairing"
  local unix_path="$out/logs/$pairing.sock"
  local peer_pid endpoints="" status
  # shellcheck disable=SC2046 # the commands are word lists by design
  timeout --kill-after=5 "$run_timeout_s" $(peer_command "$peer_kind") \
    "$unix_path" "$out/certs" >"$logs.peer.out" 2>"$logs.peer.err" &
  peer_pid=$!
  for ((i = 0; i < endpoint_wait_tenths; i++)); do
    endpoints="$(grep -m1 '^ENDPOINTS ' "$logs.peer.out" || true)"
    [[ -n "$endpoints" ]] && break
    kill -0 "$peer_pid" 2>/dev/null || break
    sleep 0.1
  done
  if [[ -z "$endpoints" ]]; then
    kill "$peer_pid" 2>/dev/null || true
    wait "$peer_pid" 2>/dev/null || true
    cat "$logs.peer.err" >&2
    fail "$pairing: peer printed no ENDPOINTS line"
    return
  fi
  read -r _ ws_port unix tls_port raw_port refused_port small_port <<<"$endpoints"
  set +e
  # shellcheck disable=SC2046
  timeout --kill-after=5 "$run_timeout_s" $(client_command "$client_kind") \
    "$ws_port" "$unix" "$tls_port" "$raw_port" "$refused_port" "$small_port" \
    "$out/certs/cert.pem" \
    >"$logs.client.out" 2>"$logs.client.err"
  status=$?
  set -e
  kill "$peer_pid" 2>/dev/null || true
  wait "$peer_pid" 2>/dev/null || true

  [[ $status -eq 0 ]] || { cat "$logs.client.err" >&2; fail "$pairing: client exited $status"; }
  grep -qxF "C DONE" "$logs.client.out" || fail "$pairing: client did not finish"
  if grep -q ' TIMEOUT$' "$logs.client.out"; then
    fail "$pairing: scenario timeouts: $(grep ' TIMEOUT$' "$logs.client.out" | tr '\n' ' ')"
  fi
  grep '^C ' "$logs.client.out" >"$logs.client.txt" || true
  # Scenarios run one at a time, but a server's close can land after the
  # next connection opens, so group server lines by URL, keeping their order.
  grep '^S ' "$logs.peer.out" | sort -s -k2,2 >"$logs.server.txt" || true

  if [[ "$pairing" == ws-ws && "${UPDATE_EXPECTED:-0}" == 1 ]]; then
    mkdir -p "$here/tests/expected"
    cp "$logs.client.txt" "$here/tests/expected/client.txt"
    cp "$logs.server.txt" "$here/tests/expected/server.txt"
  fi
  diff -u "$here/tests/expected/client.txt" "$logs.client.txt" >"$logs.client.diff" ||
    { cat "$logs.client.diff" >&2; fail "$pairing: client log differs"; }
  diff -u "$here/tests/expected/server.txt" "$logs.server.txt" >"$logs.server.diff" ||
    { cat "$logs.server.diff" >&2; fail "$pairing: server log differs"; }
  echo "$pairing: $(wc -l <"$logs.client.txt") client lines, $(wc -l <"$logs.server.txt") server lines"
}

for pairing in $pairings; do run_pairing "$pairing"; done

if [[ $failures -ne 0 ]]; then
  echo "FAIL: $failures check(s)" >&2
  exit 1
fi
echo "PASS"
