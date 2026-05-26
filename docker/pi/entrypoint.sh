#!/usr/bin/env bash
set -euo pipefail

ensure_writable_dir() {
  local dir="$1"
  local label="$2"

  if ! mkdir -p "$dir" 2>/tmp/pgo-mkdir-error; then
    {
      echo "pgo Docker runtime cannot create $label: $dir"
      cat /tmp/pgo-mkdir-error
      echo
      echo "Current container user:"
      id
      echo
      echo "Relevant permissions:"
      ls -ld "$HOME" "$HOME/.pi" "$HOME/.cache" 2>/dev/null || true
    } >&2
    exit 73
  fi

  if [[ ! -w "$dir" ]]; then
    {
      echo "pgo Docker runtime cannot write to $label: $dir"
      echo
      echo "Current container user:"
      id
      echo
      echo "Relevant permissions:"
      ls -ld "$HOME" "$HOME/.pi" "$HOME/.pi/agent" "$HOME/.cache" 2>/dev/null || true
    } >&2
    exit 73
  fi
}

ensure_writable_dir "$HOME/.pi/agent" "Pi agent home"
ensure_writable_dir "$HOME/.cache" "Pi cache"

ensure_writable_dir "$HOME/.pi/agent/bin" "Pi helper bin"
for helper in rg fd; do
  if [[ ! -e "$HOME/.pi/agent/bin/$helper" ]] && command -v "$helper" >/dev/null 2>&1; then
    ln -s "$(command -v "$helper")" "$HOME/.pi/agent/bin/$helper"
  fi
done

if [[ -z "${PI_OPENAI_BASE_URL:-}" && -n "${OPENAI_BASE_URL:-}" ]]; then
  export PI_OPENAI_BASE_URL="$OPENAI_BASE_URL"
fi

if [[ -z "${PI_OPENAI_MODEL:-}" && -n "${OPENAI_MODEL:-}" ]]; then
  export PI_OPENAI_MODEL="$OPENAI_MODEL"
fi

if [[ -z "${PI_OPENAI_API_KEY_ENV:-}" ]]; then
  if [[ -n "${PI_OPENAI_API_KEY:-}" ]]; then
    export PI_OPENAI_API_KEY_ENV="PI_OPENAI_API_KEY"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    export PI_OPENAI_API_KEY_ENV="OPENAI_API_KEY"
  fi
fi

if [[ -n "${PI_OPENAI_BASE_URL:-}" || -n "${PI_OPENAI_MODEL:-}" || -n "${PI_OPENAI_API_KEY_ENV:-}" ]]; then
  if [[ -z "${PI_OPENAI_BASE_URL:-}" || -z "${PI_OPENAI_MODEL:-}" || -z "${PI_OPENAI_API_KEY_ENV:-}" ]]; then
    {
      echo "OpenAI-compatible Pi config needs PI_OPENAI_BASE_URL, PI_OPENAI_MODEL, and PI_OPENAI_API_KEY_ENV."
      echo "You may also use OPENAI_BASE_URL, OPENAI_MODEL, and OPENAI_API_KEY."
    } >&2
    exit 64
  fi

  if [[ -z "${!PI_OPENAI_API_KEY_ENV:-}" ]]; then
    echo "API key env var '$PI_OPENAI_API_KEY_ENV' is not set inside the container." >&2
    exit 64
  fi

  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const providerName = process.env.PI_OPENAI_PROVIDER_NAME || "docker-openai";
const provider = {
  baseUrl: process.env.PI_OPENAI_BASE_URL,
  api: process.env.PI_OPENAI_API || "openai-completions",
  apiKey: process.env.PI_OPENAI_API_KEY_ENV,
  authHeader: process.env.PI_OPENAI_AUTH_HEADER === "false" ? false : true,
  models: [
    {
      id: process.env.PI_OPENAI_MODEL,
      name: process.env.PI_OPENAI_MODEL,
      reasoning: process.env.PI_OPENAI_REASONING === "true",
    },
  ],
};

const compat = {};
if (process.env.PI_OPENAI_SUPPORTS_DEVELOPER_ROLE === "false") {
  compat.supportsDeveloperRole = false;
}
if (process.env.PI_OPENAI_SUPPORTS_REASONING_EFFORT === "false") {
  compat.supportsReasoningEffort = false;
}
if (process.env.PI_OPENAI_SUPPORTS_USAGE_IN_STREAMING === "false") {
  compat.supportsUsageInStreaming = false;
}
if (process.env.PI_OPENAI_MAX_TOKENS_FIELD) {
  compat.maxTokensField = process.env.PI_OPENAI_MAX_TOKENS_FIELD;
}
if (Object.keys(compat).length > 0) {
  provider.compat = compat;
}

const modelsPath = path.join(process.env.HOME, ".pi", "agent", "models.json");
fs.writeFileSync(
  modelsPath,
  JSON.stringify({ providers: { [providerName]: provider } }, null, 2) + "\n",
  { mode: 0o600 },
);
NODE
fi

exec "$@"
