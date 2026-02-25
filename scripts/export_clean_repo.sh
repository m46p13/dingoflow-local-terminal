#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${1:-${HOME}/dingoflow-local-terminal}"
REPO_NAME="${2:-$(basename "${TARGET_DIR}")}"

echo "Exporting clean repo to: ${TARGET_DIR}"
rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'target' \
  --exclude 'models' \
  --exclude 'tmp' \
  --exclude 'release' \
  --exclude 'tests' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude '*.md' \
  --exclude '*.MD' \
  --exclude 'PHASES.md' \
  --exclude 'PARAKEET_NATIVE_MIGRATION.md' \
  "${ROOT_DIR}/" "${TARGET_DIR}/"

cd "${TARGET_DIR}"

git init
git add .
git commit -m "Initial clean terminal dictation repo"

if command -v gh >/dev/null 2>&1; then
  set +e
  gh repo create "${REPO_NAME}" --private --source=. --remote=origin --push
  GH_EXIT=$?
  set -e

  if [[ ${GH_EXIT} -ne 0 ]]; then
    echo "GitHub repo creation failed. You can push manually from:"
    echo "  ${TARGET_DIR}"
  else
    echo "GitHub repo created and pushed: ${REPO_NAME}"
  fi
else
  echo "gh CLI not found. Repo initialized locally at:"
  echo "  ${TARGET_DIR}"
fi
