#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run_pi_docker.sh [options] [workspace] [-- pi args...]

Run Pi inside Docker with exactly one mounted workspace.
The workspace defaults to the current directory and is mounted read-only.
By default Pi starts with read, grep, find, ls, and read_only_git only.
Project skills in .pgo/skills are loaded automatically when present.
The container root filesystem is read-only by default; Pi gets tmpfs scratch space.

Options:
  --image NAME           Docker image tag (default: pgo-runtime:latest)
  --extension PATH       Explicit Pi extension path inside the workspace; repeatable
  --write                Mount workspace read-write instead of read-only
  --writable-container   Allow writes to the container filesystem
  --offline              Disable container networking
  --shell                Start bash inside the container instead of Pi; with --, run that command
  --pi-home PATH         Mount a host Pi config directory at /home/node/.pi
  --keep-session         Allow Pi to write session files in the container home
  --tools LIST           Pi tool allowlist (default: read,grep,find,ls,read_only_git)
  --no-project-skills    Do not load workspace .pgo/skills
  --no-read-only-git     Do not load the baked-in read_only_git tool
  --no-safety-flags      Do not add --no-extensions/--no-skills/etc.
  --base-url URL         OpenAI-compatible base URL for generated Pi provider
  --model ID             OpenAI-compatible model ID for generated Pi provider
  --api-key-env NAME     Host env var containing the API key (default: PI_OPENAI_API_KEY or OPENAI_API_KEY)
  --provider-name NAME   Generated Pi provider name (default: docker-openai)
  --api NAME             Pi API type (default: openai-completions)
  -h, --help             Show this help

Env alternatives:
  PI_OPENAI_BASE_URL or OPENAI_BASE_URL
  PI_OPENAI_MODEL or OPENAI_MODEL
  PI_OPENAI_API_KEY or OPENAI_API_KEY

Examples:
  scripts/run_pi_docker.sh

  pgo work-app

  scripts/run_pi_docker.sh --base-url https://your-provider.example/v1 \
    --model your-model-id \
    --api-key-env SECURELY_POPULATED_ENV_VAR \
    /path/to/repo
EOF
}

resolve_image_ref() {
  local requested="$1"
  local image_id

  if docker image inspect "$requested" >/dev/null 2>&1; then
    printf '%s' "$requested"
    return 0
  fi

  image_id="$(
    docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null \
      | awk -v image="$requested" '$1 == image { print $2; exit }'
  )"

  if [[ -n "$image_id" ]]; then
    printf '%s' "$image_id"
    return 0
  fi

  return 1
}

image="${PI_DOCKER_IMAGE:-pgo-runtime:latest}"
readonly_git_extension="/opt/pi/extensions/read-only-git.ts"
mount_mode="ro"
readonly_container=1
workspace=""
pi_home=""
start_shell=0
safety_flags=1
keep_session=0
load_readonly_git=1
load_project_skills=1
network_args=()
extensions=()
pi_args=()
tool_allowlist="${PI_DOCKER_TOOLS:-read,grep,find,ls,read_only_git}"
base_url_arg=""
model_arg=""
api_key_env_arg=""
provider_name_arg=""
api_arg=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      image="${2:?missing image name}"
      shift 2
      ;;
    --extension|-e)
      extensions+=("${2:?missing extension path}")
      shift 2
      ;;
    --write)
      mount_mode="rw"
      shift
      ;;
    --writable-container)
      readonly_container=0
      shift
      ;;
    --offline)
      network_args=(--network none)
      shift
      ;;
    --shell)
      start_shell=1
      shift
      ;;
    --pi-home)
      pi_home="${2:?missing Pi home path}"
      shift 2
      ;;
    --keep-session)
      keep_session=1
      shift
      ;;
    --tools)
      tool_allowlist="${2:?missing tool allowlist}"
      shift 2
      ;;
    --no-project-skills)
      load_project_skills=0
      shift
      ;;
    --no-read-only-git)
      load_readonly_git=0
      if [[ "$tool_allowlist" == "read,grep,find,ls,read_only_git" ]]; then
        tool_allowlist="read,grep,find,ls"
      fi
      shift
      ;;
    --no-safety-flags)
      safety_flags=0
      shift
      ;;
    --base-url)
      base_url_arg="${2:?missing base URL}"
      shift 2
      ;;
    --model)
      model_arg="${2:?missing model ID}"
      shift 2
      ;;
    --api-key-env)
      api_key_env_arg="${2:?missing API key env var name}"
      shift 2
      ;;
    --provider-name)
      provider_name_arg="${2:?missing provider name}"
      shift 2
      ;;
    --api)
      api_arg="${2:?missing Pi API type}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      pi_args=("$@")
      break
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
    *)
      if [[ -z "$workspace" ]]; then
        workspace="$1"
      else
        pi_args+=("$1")
      fi
      shift
      ;;
  esac
done

workspace="${workspace:-$PWD}"
if [[ ! -d "$workspace" ]]; then
  echo "Workspace does not exist or is not a directory: $workspace" >&2
  exit 66
fi
workspace="$(cd "$workspace" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not available on PATH." >&2
  exit 69
fi

if ! docker info >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Docker is installed, but the Docker daemon is not reachable.
Start Docker Desktop, then run this command again.
EOF
  exit 69
fi

resolved_image="$(resolve_image_ref "$image" || true)"
if [[ -z "$resolved_image" ]]; then
  cat >&2 <<EOF
Docker image '$image' was not found.
Build it first with:
  scripts/build_pi_docker.sh --image "$image"
EOF
  exit 69
fi

for extension in "${extensions[@]}"; do
  case "$extension" in
    /*)
      echo "Use workspace-relative extension paths, not host absolute paths: $extension" >&2
      exit 64
      ;;
    *)
      if [[ ! -f "$workspace/$extension" ]]; then
        echo "Extension does not exist in workspace: $extension" >&2
        exit 66
      fi
      ;;
  esac
done

if [[ -n "$pi_home" && ! -d "$pi_home" ]]; then
  echo "Pi home path does not exist. Create it first if you want persistent Pi config: $pi_home" >&2
  exit 66
fi

base_url="${base_url_arg:-${PI_OPENAI_BASE_URL:-${OPENAI_BASE_URL:-}}}"
model_id="${model_arg:-${PI_OPENAI_MODEL:-${OPENAI_MODEL:-}}}"
api_key_env="$api_key_env_arg"
if [[ -z "$api_key_env" ]]; then
  if [[ -n "${PI_OPENAI_API_KEY:-}" ]]; then
    api_key_env="PI_OPENAI_API_KEY"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    api_key_env="OPENAI_API_KEY"
  fi
fi

model_config_requested=0
if [[ -n "$base_url" || -n "$model_id" || -n "$api_key_env" ]]; then
  model_config_requested=1
fi

if [[ "$model_config_requested" -eq 1 ]]; then
  if [[ -z "$base_url" || -z "$model_id" || -z "$api_key_env" ]]; then
    {
      echo "Model config needs base URL, model ID, and API key env var."
      echo "Use --base-url, --model, and --api-key-env, or set PI_OPENAI_BASE_URL, PI_OPENAI_MODEL, and PI_OPENAI_API_KEY."
    } >&2
    exit 64
  fi
  if [[ -z "${!api_key_env:-}" ]]; then
    echo "API key env var is not set on the host: $api_key_env" >&2
    exit 64
  fi
fi

docker_args=(
  run
  --rm
  "${network_args[@]}"
  -v "$workspace:/workspace:$mount_mode"
  -w /workspace
  -e PI_SKIP_VERSION_CHECK=1
  -e PI_TELEMETRY=0
  --cap-drop ALL
  --security-opt no-new-privileges
)

if [[ "$readonly_container" -eq 1 ]]; then
  docker_args+=(
    --read-only
    --tmpfs /tmp:rw,nosuid,nodev,size=64m
    --tmpfs /home/node/.cache:rw,nosuid,nodev,size=64m
  )
fi

if [[ -t 0 && -t 1 ]]; then
  docker_args+=(-it)
fi

if [[ -n "$pi_home" ]]; then
  pi_home="$(cd "$pi_home" && pwd)"
  docker_args+=(-v "$pi_home:/home/node/.pi:rw")
elif [[ "$readonly_container" -eq 1 ]]; then
  docker_args+=(--tmpfs /home/node/.pi:rw,nosuid,nodev,exec,size=64m)
fi

if [[ "$model_config_requested" -eq 1 ]]; then
  provider_name="${provider_name_arg:-${PI_OPENAI_PROVIDER_NAME:-docker-openai}}"
  api_name="${api_arg:-${PI_OPENAI_API:-openai-completions}}"
  docker_args+=(
    -e "PI_OPENAI_BASE_URL=$base_url"
    -e "PI_OPENAI_MODEL=$model_id"
    -e "PI_OPENAI_API_KEY_ENV=$api_key_env"
    -e "$api_key_env"
    -e "PI_OPENAI_PROVIDER_NAME=$provider_name"
    -e "PI_OPENAI_API=$api_name"
  )

  for optional_env in \
    PI_OPENAI_AUTH_HEADER \
    PI_OPENAI_REASONING \
    PI_OPENAI_SUPPORTS_DEVELOPER_ROLE \
    PI_OPENAI_SUPPORTS_REASONING_EFFORT \
    PI_OPENAI_SUPPORTS_USAGE_IN_STREAMING \
    PI_OPENAI_MAX_TOKENS_FIELD
  do
    if [[ -n "${!optional_env:-}" ]]; then
      docker_args+=(-e "$optional_env")
    fi
  done
fi

if [[ "$start_shell" -eq 1 ]]; then
  if [[ "${#pi_args[@]}" -gt 0 ]]; then
    command=("${pi_args[@]}")
  else
    command=(bash)
  fi
else
  command=(pi)
  if [[ "$model_config_requested" -eq 1 ]]; then
    command+=(--provider "$provider_name" --model "$model_id")
  fi
  if [[ "$safety_flags" -eq 1 ]]; then
    command+=(--no-extensions --no-skills --no-prompt-templates --no-context-files)
  fi
  if [[ "$load_project_skills" -eq 1 && -d "$workspace/.pgo/skills" ]]; then
    command+=(--skill .pgo/skills)
  fi
  if [[ -n "$tool_allowlist" ]]; then
    command+=(--tools "$tool_allowlist")
  fi
  if [[ "$keep_session" -eq 0 ]]; then
    command+=(--no-session)
  fi
  if [[ "$load_readonly_git" -eq 1 ]]; then
    command+=(-e "$readonly_git_extension")
  fi
  for extension in "${extensions[@]}"; do
    command+=(-e "$extension")
  done
  command+=("${pi_args[@]}")
fi

exec docker "${docker_args[@]}" "$resolved_image" "${command[@]}"
