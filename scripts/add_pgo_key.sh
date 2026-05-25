#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/add_pgo_key.sh [options]

Store or update the pgo API key in macOS Keychain.

Options:
  --service NAME   Advanced: Keychain service label (default: pgo_ak, or PGO_KEYCHAIN_SERVICE)
  --account NAME   Advanced: Keychain account label (default: pgo_ak, or PGO_KEYCHAIN_ACCOUNT)
  -h, --help       Show this help

The key is read with a hidden prompt and is not written to this repo.
Most users can ignore the advanced options.
EOF
}

die() {
  echo "add_pgo_key: $*" >&2
  exit 1
}

service="${PGO_KEYCHAIN_SERVICE:-pgo_ak}"
account="${PGO_KEYCHAIN_ACCOUNT:-pgo_ak}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      service="${2:?missing Keychain service}"
      shift 2
      ;;
    --account)
      account="${2:?missing Keychain account}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

[[ -n "$service" ]] || die "Keychain service cannot be empty"
[[ -n "$account" ]] || die "Keychain account cannot be empty"
command -v security >/dev/null 2>&1 || die "macOS security command not found"

printf 'API key label: %s\n' "$service"
if [[ "$account" != "$service" ]]; then
  printf 'Keychain account label: %s\n' "$account"
fi
read -rsp "API key: " api_key
printf '\n'

[[ -n "$api_key" ]] || die "API key cannot be empty"

security add-generic-password \
  -a "$account" \
  -s "$service" \
  -w "$api_key" \
  -U

unset api_key
printf 'Stored API key in macOS Keychain for service/account: %s/%s\n' "$service" "$account"
