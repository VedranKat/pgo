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

## Read-Only Git

The baked-in `read_only_git` extension is constrained to local, non-mutating Git inspection. It is intended to avoid shell access for common review tasks while still handling large repositories.

For large release or branch comparisons, prefer summary operations before full patches:

```text
diff_shortstat
diff_dirstat
diff_name_status
diff_numstat
```

Diff operations enable rename detection so refactors are reported as renames when Git can infer them.

Line-oriented operations support `offset` pagination. If a result reports `hasMore` and `nextOffset`, continue with the same parameters and the next offset only when more of that listing is needed. If a result is truncated by `maxChars`, narrow with `path` or switch to a summary operation rather than repeating the same call.

Use `comparison=direct` for exact release/tag-to-ref comparisons and the default `comparison=merge-base` for branch review.
