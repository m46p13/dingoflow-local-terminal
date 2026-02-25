#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required: https://brew.sh"
  exit 1
fi

brew install ffmpeg python@3.11 rust cmake

python3.11 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

pip install --upgrade pip
pip install -r "$ROOT_DIR/python/requirements.txt"

cat <<MSG

Setup complete.

Next steps:
1) Download local ASR and formatter models (see README.md). For native Parakeet default, run ./scripts/download_parakeet_tdt_onnx.sh
2) export DINGOFLOW_PYTHON_BIN="$VENV_DIR/bin/python"
3) Optional native builds: ./scripts/build_native_audio.sh ./scripts/build_native_asr.sh ./scripts/build_native_parakeet.sh ./scripts/build_native_injector.sh
4) npm install && npm run dev

MSG
