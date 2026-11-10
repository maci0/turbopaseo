#!/usr/bin/env bash
# Builds the sherpa-onnx shim and, given an entry, a scriptc executable that uses it.
#
#   build.sh                      shim archive build/libsherpa_shim.a and build/lib/*.so
#   build.sh <entry.ts> <out>     also: scriptc build with ffi.json, RUNPATH $ORIGIN/lib,
#                                 and <out dir>/lib/*.so plus <out dir>/assets/silero_vad.onnx
#
# scriptc reads the tsconfig.json nearest the entry, and the entry's program must contain
# sherpa-onnx-ffi.ts (it declares every binding ffi.json lists). Host tools: c++, ar, patchelf.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here"
while [[ ! -d "$root/.scratch" ]]; do
  [[ "$root" == / ]] && { echo "no .scratch/ above $here" >&2; exit 1; }
  root="$(dirname "$root")"
done

scriptc="$root/.scratch/scriptc-tool/node_modules/.bin/scriptc"
include="$root/.scratch/sherpa/upstream/include"
platform_pkg="$root/work/paseo/node_modules/sherpa-onnx-linux-x64"
vad_model="$root/work/paseo/packages/server/src/server/speech/providers/local/sherpa/assets/silero_vad.onnx"

mkdir -p "$here/build/lib"
cp "$platform_pkg/libsherpa-onnx-c-api.so" "$platform_pkg/libonnxruntime.so" "$here/build/lib/"
c++ -std=c++17 -O2 -Wall -Wextra -Werror -fPIC -I"$include" \
  -c "$here/sherpa_shim.cc" -o "$here/build/sherpa_shim.o"
ar rcs "$here/build/libsherpa_shim.a" "$here/build/sherpa_shim.o"

[[ $# -eq 0 ]] && exit 0
[[ $# -eq 2 ]] || { echo "usage: build.sh [<entry.ts> <out>]" >&2; exit 2; }

entry="$(realpath "$1")"
out="$(realpath -m "$2")"
out_dir="$(dirname "$out")"
mkdir -p "$out_dir/lib" "$out_dir/assets"
(cd "$(dirname "$entry")" &&
  "$scriptc" build "$entry" --ffi "$here/ffi.json" -o "$out" --optimization dev --node-islands=off)
# The manifest has no rpath field; point the loader at the libraries beside the binary.
patchelf --set-rpath '$ORIGIN/lib' "$out"
cp "$here/build/lib/libsherpa-onnx-c-api.so" "$here/build/lib/libonnxruntime.so" "$out_dir/lib/"
cp "$vad_model" "$out_dir/assets/"
