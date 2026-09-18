#!/usr/bin/env bash
# Build the wasm crate and emit browser bindings into public/wasm.
#
# Usage: scripts/build-wasm.sh [--release|--dev] [extra wasm-pack args]
set -euo pipefail
cd "$(dirname "$0")/.."

# Host toolchains (conda/miniforge/homebrew) sometimes export AR/RANLIB/CC and
# host CFLAGS/LDFLAGS. Those break compiling `ring` to wasm32-unknown-unknown
# (corrupt archive, or undefined `__stack_chk_guard`). Strip them and, when
# available, point the wasm target at LLVM's archiver.
unset AR RANLIB CC CXX CFLAGS CXXFLAGS LDFLAGS CPPFLAGS 2>/dev/null || true
if command -v llvm-ar >/dev/null 2>&1; then
  export AR_wasm32_unknown_unknown="$(command -v llvm-ar)"
fi
if command -v llvm-ranlib >/dev/null 2>&1; then
  export RANLIB_wasm32_unknown_unknown="$(command -v llvm-ranlib)"
fi

if [ "$#" -eq 0 ]; then
  set -- --release
fi

exec wasm-pack build \
  --target web \
  --out-dir public/wasm \
  --out-name iroh_mic \
  --no-pack \
  "$@"
