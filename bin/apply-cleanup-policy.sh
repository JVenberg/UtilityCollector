#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy \
  --project=utilitysplitter \
  --location=us-central1 \
  --policy="$SCRIPT_DIR/../artifact-registry-cleanup-policy.json"
