#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/add_pgo_provider.sh [options]

Configure or replace the default OpenAI-compatible provider used by pgo.

Options:
  --config PATH            Config path (default: $HOME/.config/pgo/projects.conf, or PGO_CONFIG)
  --base-url URL           Provider base URL, for example https://api.company.example/v1
  --model ID               Model ID, for example company-model-id
  --keychain-service NAME  Advanced: Keychain service label (default: current config or pgo_ak)
  --keychain-account NAME  Advanced: Keychain account label (default: current config or pgo_ak)
  --api-key-env NAME       Advanced: container env var name (default: current config or pgo_ak)
  --skip-key               Advanced: update provider config without prompting for the key
  -h, --help               Show this help

This writes model/provider settings only. Re-running it replaces the current
default provider settings. It also prompts for the provider API key and stores
it in macOS Keychain. Most users should not pass the advanced options.
EOF
}

die() {
  echo "add_pgo_provider: $*" >&2
  exit 1
}

expand_home() {
  local value="$1"
  case "$value" in
    "~")
      printf '%s' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s' "$HOME" "${value#"~/"}"
      ;;
    "\$HOME")
      printf '%s' "$HOME"
      ;;
    "\$HOME/"*)
      printf '%s/%s' "$HOME" "${value#"\$HOME/"}"
      ;;
    *)
      printf '%s' "$value"
      ;;
  esac
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

config_value() {
  local wanted_key="$1"
  local line key value

  [[ -f "$config_path" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *"="* ]] || continue

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [[ "$key" == "$wanted_key" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < "$config_path"

  return 1
}

prompt_value() {
  local label="$1"
  local default_value="$2"
  local value

  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$label: " value
    printf '%s' "$value"
  fi
}

upsert_config_key() {
  local wanted_key="$1"
  local wanted_value="$2"
  local tmp

  tmp="$(mktemp "${config_path}.XXXXXX")"
  awk -v wanted_key="$wanted_key" -v replacement="$wanted_key = $wanted_value" '
    BEGIN { replaced = 0 }
    {
      line = $0
      trimmed = line
      sub(/^[[:space:]]+/, "", trimmed)
      if (!replaced && trimmed !~ /^#/ && trimmed ~ /=/) {
        candidate = trimmed
        sub(/[[:space:]]*=.*/, "", candidate)
        sub(/[[:space:]]+$/, "", candidate)
        if (candidate == wanted_key) {
          print replacement
          replaced = 1
          next
        }
      }
      print line
    }
    END {
      if (!replaced) {
        print replacement
      }
    }
  ' "$config_path" > "$tmp"
  mv "$tmp" "$config_path"
}

config_path="${PGO_CONFIG:-$HOME/.config/pgo/projects.conf}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
key_script="$script_dir/add_pgo_key.sh"
base_url=""
model=""
keychain_service=""
keychain_account=""
api_key_env=""
skip_key=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      config_path="${2:?missing config path}"
      shift 2
      ;;
    --base-url)
      base_url="${2:?missing base URL}"
      shift 2
      ;;
    --model)
      model="${2:?missing model ID}"
      shift 2
      ;;
    --keychain-service)
      keychain_service="${2:?missing Keychain service}"
      shift 2
      ;;
    --keychain-account)
      keychain_account="${2:?missing Keychain account}"
      shift 2
      ;;
    --api-key-env)
      api_key_env="${2:?missing API key env var}"
      shift 2
      ;;
    --skip-key)
      skip_key=1
      shift
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

config_path="$(expand_home "$config_path")"
[[ -f "$config_path" ]] || die "config not found: $config_path. Run scripts/install_pgo.sh first."

printf 'pgo project config: %s\n\n' "$config_path"
printf 'Examples:\n'
printf '  Base URL: https://api.company.example/v1\n'
printf '  Model ID: company-model-id\n\n'

current_base_url="$(config_value base_url || true)"
current_model="$(config_value model || true)"
current_service="$(config_value keychain_service || true)"
current_account="$(config_value keychain_account || true)"
current_env="$(config_value api_key_env || true)"

base_url="${base_url:-$(prompt_value "Provider base URL" "$current_base_url")}"
model="${model:-$(prompt_value "Model ID" "$current_model")}"
keychain_service="${keychain_service:-${current_service:-pgo_ak}}"
keychain_account="${keychain_account:-${current_account:-$keychain_service}}"
api_key_env="${api_key_env:-${current_env:-pgo_ak}}"

[[ "$base_url" == http://* || "$base_url" == https://* ]] || die "base URL must start with http:// or https://"
[[ -n "$model" ]] || die "model ID cannot be empty"
[[ -n "$keychain_service" ]] || die "Keychain service cannot be empty"
[[ -n "$keychain_account" ]] || die "Keychain account cannot be empty"
[[ "$api_key_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "API key env var must be a valid shell variable name"

upsert_config_key base_url "$base_url"
upsert_config_key model "$model"
upsert_config_key keychain_service "$keychain_service"
upsert_config_key keychain_account "$keychain_account"
upsert_config_key api_key_env "$api_key_env"

cat <<EOF
Updated default pgo provider:
  base_url = $base_url
  model = $model
  API key label = $keychain_service

EOF

if [[ "$skip_key" -eq 1 ]]; then
  cat <<EOF
Skipped API key storage. To store or update it later, run:
  $key_script --service "$keychain_service" --account "$keychain_account"
EOF
else
  printf '\nStore or update the provider API key now.\n'
  "$key_script" --service "$keychain_service" --account "$keychain_account"
fi
