# pgo Docker Runtime

Pi runs only inside Docker.

Default posture:

```text
workspace: /workspace, read-only
container root: read-only
scratch: tmpfs only
tools: read, grep, find, ls, read_only_git
session: ephemeral
extensions: only the baked-in read_only_git extension
```

Run:

```sh
scripts/run_pi_docker.sh /path/to/repo
```

For online OpenAI-compatible models, prefer the `pgo` launcher so API keys are read from macOS Keychain instead of shell commands.

```sh
pgo work-app
```

The lower-level runner can still accept a base URL, model, and API-key environment variable when another secure process has already populated that environment.

The image is reusable across machines after build or `docker load`.
