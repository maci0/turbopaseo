#!/usr/bin/env bash
# Compile pty.c into libpty.a next to this script, for the host target.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cc="${CC:-clang}"

"$cc" -std=c11 -O2 -g -Wall -Wextra -Werror -pthread -fPIC \
  -c "$here/pty.c" -o "$here/pty.o"
rm -f "$here/libpty.a"
ar rcs "$here/libpty.a" "$here/pty.o"
rm -f "$here/pty.o"
echo "built $here/libpty.a"
