#!/usr/bin/env bash
set -euo pipefail

ffmpeg -f avfoundation -list_devices true -i ""
