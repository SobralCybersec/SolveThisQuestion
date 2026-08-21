#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
git -C "$ROOT" apply --reverse -p0 "$ROOT/.audit/postimages-fix.patch"
