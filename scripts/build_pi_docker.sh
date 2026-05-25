#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build_pi_docker.sh [--image NAME]

Builds the Docker image that contains Pi, Node, git, and read_only_git.
This downloads Docker/npm packages when run.

Options:
  --image NAME   Image tag to build (default: pgo-runtime:latest)
  -h, --help     Show this help
EOF
}

image="${PI_DOCKER_IMAGE:-pgo-runtime:latest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      image="${2:?missing image name}"
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

docker build \
  --tag "$image" \
  --file "$repo_root/docker/pi/Dockerfile" \
  "$repo_root"
