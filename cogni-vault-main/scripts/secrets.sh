#!/bin/sh
# Scan the repo for secrets with gitleaks, using .gitleaks.toml.
# Uses a local gitleaks binary when installed, otherwise the pinned Docker image.
#   sh scripts/secrets.sh                          # whole git history
#   sh scripts/secrets.sh --pre-commit --staged    # staged changes only (the pre-commit hook)
set -eu
# Pinned by digest so a re-pushed tag cannot change what runs.
IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
cd "$(git rev-parse --show-toplevel)"

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks git --no-banner --redact "$@" .
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  # Run as the checkout's owner. Otherwise git refuses the repository for
  # "dubious ownership" and gitleaks scans 0 commits and still exits 0.
  exec docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/repo:ro" "$IMAGE" git --no-banner --redact "$@" /repo
fi
echo "secrets scan: install gitleaks or start Docker. To skip once (not recommended): git commit --no-verify" >&2
exit 1
