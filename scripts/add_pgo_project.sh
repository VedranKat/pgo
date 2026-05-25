#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/add_pgo_project.sh [options]

Add or update a project nickname in the pgo project config.

Options:
  --config PATH   Config path (default: $HOME/.config/pgo/projects.conf, or PGO_CONFIG)
  --name NAME     Project nickname, for example work-app
  --path PATH     Workspace path, for example $HOME/Projects/work-app
  -h, --help      Show this help
EOF
}

die() {
  echo "add_pgo_project: $*" >&2
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

portable_path() {
  local expanded="$1"
  case "$expanded" in
    "$HOME")
      printf '$HOME'
      ;;
    "$HOME/"*)
      printf '$HOME/%s' "${expanded#"$HOME/"}"
      ;;
    *)
      printf '%s' "$expanded"
      ;;
  esac
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
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
project_name=""
workspace_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      config_path="${2:?missing config path}"
      shift 2
      ;;
    --name)
      project_name="${2:?missing project nickname}"
      shift 2
      ;;
    --path)
      workspace_path="${2:?missing workspace path}"
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

config_path="$(expand_home "$config_path")"
[[ -f "$config_path" ]] || die "config not found: $config_path. Run scripts/install_pgo.sh first."

printf 'pgo project config: %s\n\n' "$config_path"
printf 'Path examples:\n'
printf '  $HOME/Projects/work-app\n'
printf '  ~/Projects/work-app\n'
printf '  /Users/alex/Projects/work-app\n\n'

if [[ -z "$project_name" ]]; then
  read -r -p "Project nickname: " project_name
fi

if [[ -z "$workspace_path" ]]; then
  read -r -p "Workspace path: " workspace_path
fi

[[ "$project_name" =~ ^[A-Za-z0-9._-]+$ ]] || die "project nickname may contain only letters, numbers, dot, underscore, and dash"
[[ -n "$workspace_path" ]] || die "workspace path cannot be empty"

expanded_workspace="$(expand_home "$workspace_path")"
[[ -d "$expanded_workspace" ]] || die "workspace path does not exist or is not a directory: $expanded_workspace"
expanded_workspace="$(cd "$expanded_workspace" && pwd)"
stored_workspace="$(portable_path "$expanded_workspace")"

upsert_config_key "project.$project_name" "$stored_workspace"

cat <<EOF
Updated pgo project:
  project.$project_name = $stored_workspace

Start interactive mode with:
  pgo $project_name
EOF
