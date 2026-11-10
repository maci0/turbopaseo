#!/usr/bin/env bash
# Builds and runs the sherpa proofs from this directory's sources.
#
#   run.sh <models-dir> <scratch-dir> <tts-model-id>
#
# Copies proof.ts, ffi-check.ts, pino-stub.ts and tsconfig.json into
# work/paseo/packages/server/zzprobe-sherpa/ and speech-worker.ts into packages/server/native/
# (where worker-client.ts forks it natively), builds both binaries into <scratch-dir>/bin, runs
# proof.ts under Node (real addon) and natively on one shared STT/VAD input, diffs the two, runs
# ffi-check natively, then removes both copies again. <models-dir> holds the extracted model
# archives (parakeet-tdt-110m-en-int8 for STT and the given TTS model).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [[ ! -d "$root/.scratch" ]]; do
  [[ "$root" == / ]] && { echo "no .scratch/ above $here" >&2; exit 1; }
  root="$(dirname "$root")"
done
[[ $# -eq 3 ]] || { echo "usage: run.sh <models-dir> <scratch-dir> <tts-model-id>" >&2; exit 2; }
models="$(realpath "$1")"
scratch="$(realpath -m "$2")"
server="$root/work/paseo/packages/server"
probe="$server/zzprobe-sherpa"
mkdir -p "$scratch/bin" "$scratch/tmp" "$scratch/runs" "$probe" "$server/native"
cp "$here/proof.ts" "$here/ffi-check.ts" "$here/pino-stub.ts" "$here/tsconfig.json" "$probe/"
cp "$here/../speech-worker.ts" "$server/native/"
cleanup() { rm -rf "$probe" "$server/native/speech-worker.ts"; rmdir "$server/native" 2>/dev/null || true; }
trap cleanup EXIT

(cd "$server" && "$here/../build.sh" zzprobe-sherpa/proof.ts "$scratch/bin/proof" > "$scratch/build-proof.log" 2>&1) ||
  { echo "proof build failed: $scratch/build-proof.log" >&2; exit 1; }
(cd "$server" && "$here/../build.sh" zzprobe-sherpa/ffi-check.ts "$scratch/bin/ffi-check" > "$scratch/build-check.log" 2>&1) ||
  { echo "ffi-check build failed: $scratch/build-check.log" >&2; exit 1; }

export TMPDIR="$scratch/tmp" PROOF_MODELS_DIR="$models" PROOF_STT_MODEL=parakeet-tdt-110m-en-int8
export PROOF_TTS_MODEL="$3" PROOF_TEXT="The quick brown fox jumps over the lazy dog. Native speech works."
export PROOF_AUDIO_FILE="$scratch/runs/$3.pcm" PROOF_VAD_MODEL="$scratch/bin/assets/silero_vad.onnx"
rm -f "$PROOF_AUDIO_FILE"
(cd "$server" && timeout 200 node --import tsx zzprobe-sherpa/proof.ts > "$scratch/runs/$3.node.out" 2> "$scratch/runs/$3.node.err")
echo "node exit=$?"
(cd / && timeout 200 "$scratch/bin/proof" > "$scratch/runs/$3.native.out" 2> "$scratch/runs/$3.native.err")
echo "native exit=$?"
echo "--- node"; cat "$scratch/runs/$3.node.out"
echo "--- native"; cat "$scratch/runs/$3.native.out"
echo "--- diff"; diff "$scratch/runs/$3.node.out" "$scratch/runs/$3.native.out" && echo identical
echo "--- ffi-check"; (cd / && timeout 120 "$scratch/bin/ffi-check"); echo "ffi-check exit=$?"
