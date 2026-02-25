#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cargo build --release --manifest-path "${ROOT_DIR}/native/parakeet_worker/Cargo.toml"

echo "Native Parakeet binary built at:"
echo "  ${ROOT_DIR}/native/parakeet_worker/target/release/dingoflow-parakeet-worker"
