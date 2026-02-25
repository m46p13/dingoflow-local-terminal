#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC="${ROOT_DIR}/native/text_injector/src/main.swift"
OUT_DIR="${ROOT_DIR}/native/text_injector/bin"
OUT_BIN="${OUT_DIR}/dingoflow-text-injector"

mkdir -p "${OUT_DIR}"

swiftc -O \
  -framework ApplicationServices \
  "${SRC}" \
  -o "${OUT_BIN}"

chmod +x "${OUT_BIN}"

echo "Native text injector binary built at:"
echo "  ${OUT_BIN}"
