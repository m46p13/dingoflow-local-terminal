#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

MODEL_DIR="${DINGOFLOW_ASR_MODEL_PATH:-${ROOT_DIR}/models/parakeet-tdt-0.6b-v3-onnx}"

if [[ ! -d "${MODEL_DIR}" ]]; then
  echo "Missing model directory: ${MODEL_DIR}"
  echo "Run: ./scripts/download_parakeet_tdt_onnx.sh"
  exit 1
fi

if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
  npm install
fi

./scripts/build_native_audio.sh
./scripts/build_native_parakeet.sh
npm run build

export DINGOFLOW_ASR_BACKEND="${DINGOFLOW_ASR_BACKEND:-parakeet-native}"
export DINGOFLOW_RECORDER_BACKEND="${DINGOFLOW_RECORDER_BACKEND:-native-rust}"
export DINGOFLOW_ASR_TRANSPORT="${DINGOFLOW_ASR_TRANSPORT:-framed}"
export DINGOFLOW_PARAKEET_FINAL_PASS="${DINGOFLOW_PARAKEET_FINAL_PASS:-false}"
export DINGOFLOW_SPOKEN_FORMATTING_COMMANDS="${DINGOFLOW_SPOKEN_FORMATTING_COMMANDS:-true}"
export DINGOFLOW_ASR_MODEL_PATH="${MODEL_DIR}"
export DINGOFLOW_NATIVE_AUDIO_BIN="${DINGOFLOW_NATIVE_AUDIO_BIN:-${ROOT_DIR}/native/audio_loop/target/release/dingoflow-audio-loop}"
export DINGOFLOW_NATIVE_PARAKEET_BIN="${DINGOFLOW_NATIVE_PARAKEET_BIN:-${ROOT_DIR}/native/parakeet_worker/target/release/dingoflow-parakeet-worker}"

echo "Starting terminal dictation..."
echo "Model: ${DINGOFLOW_ASR_MODEL_PATH}"
echo "Press Enter to start/stop. /quit to exit."

node "${ROOT_DIR}/dist/cli/liveTerminal.js"
