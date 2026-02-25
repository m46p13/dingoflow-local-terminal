#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODEL_DIR="${ROOT_DIR}/models/parakeet-tdt-0.6b-v3-onnx"
PY_BIN="${DINGOFLOW_PYTHON_BIN:-python3}"

mkdir -p "${MODEL_DIR}"

if ! "${PY_BIN}" - <<'PY' >/dev/null 2>&1
import huggingface_hub  # noqa: F401
PY
then
  echo "Installing Python download deps (huggingface_hub, hf_transfer)..."
  "${PY_BIN}" -m pip --version >/dev/null 2>&1 || "${PY_BIN}" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "${PY_BIN}" -m pip install --quiet --upgrade huggingface_hub hf_transfer
fi

export HF_HUB_ENABLE_HF_TRANSFER="${HF_HUB_ENABLE_HF_TRANSFER:-1}"

"${PY_BIN}" - <<PY
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id='istupakov/parakeet-tdt-0.6b-v3-onnx',
    local_dir=r"${MODEL_DIR}",
)
print(r"${MODEL_DIR}")
PY

echo "Downloaded Parakeet TDT ONNX model to:"
echo "  ${MODEL_DIR}"
