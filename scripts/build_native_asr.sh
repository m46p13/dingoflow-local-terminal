#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cargo build --release --manifest-path "${ROOT_DIR}/native/asr_worker/Cargo.toml"

echo "Native ASR binary built at:"
echo "  ${ROOT_DIR}/native/asr_worker/target/release/dingoflow-asr-worker"
