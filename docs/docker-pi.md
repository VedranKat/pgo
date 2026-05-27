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

For repository discovery without shelling out, use:

```text
rev_list   page commit hashes and parent topology; use for counts/topology
refs       list local branches, tags, and remote-tracking refs without remote URLs
grep       search tracked content; fixed-string by default, regex only when requested
ls_tree    list tracked tree entries at any ref, optionally narrowed by path
```

Diff operations enable rename detection so refactors are reported as renames when Git can infer them.

Line-oriented operations support `offset` pagination. If a result reports `hasMore` and `nextOffset`, continue with the same parameters and the next offset only when more of that listing is needed. If a result is truncated by `maxChars`, narrow with `path`, `pattern`, or a summary operation rather than repeating the same call.

Do not repeat an identical successful `read_only_git` call. If the output is complete, use it; if it does not answer the question, choose a different operation or parameters.

Diff operations without `base` compare the working tree, not branch history. For branch history or ref-to-ref comparison, always include `base` and `ref`. If `comparison` is set for a diff operation, `base` is required.

Use `comparison=direct` for exact release/tag/ref-to-ref tree comparisons and for symmetric questions like which files differ between branch A and branch B. The words “differ between”, “different between”, or “compare A and B” usually mean direct tree comparison unless the user specifically asks for branch review or changes since the merge base. Use the default `comparison=merge-base` for branch review. For branch-specific changes since divergence, set `base` to the destination/other branch and `ref` to the source branch. For example, “what would `main` get by merging this branch?” is `base=main`, `ref=HEAD`; “what is on `main` but not this branch?” is `base=HEAD`, `ref=main`. Direct branch-to-branch diffs can show deletions for files that exist only on the opposite side.

When a user asks what changed on this branch, whether a file changed on this branch, or whether there are renames on this branch, inspect committed branch history against the merge base, usually `base=main` and `ref=HEAD`. Do not answer these branch-history questions from `status` or a bare working-tree diff unless the user asks about local/uncommitted work.

When the user asks what changed on another branch, treat changed as changed files or a file summary unless they specifically ask only for commits. Use `diff_name_status`, `diff`, or `show` to inspect changed files, not only `rev_list` or `log`.

For file-level churn questions like which file changed most, use `diff_numstat`, optionally with `path=<directory>`. `diff_dirstat` answers directory-level hotspots, not the largest file.

For ahead/behind commit counts, use `rev_list` with `base=<other>` and `ref=<branch>`. `rev_list` output has one commit per output line; count output lines or use `linesReturned`. Parent hashes after the first hash are not additional commits. To decide whether a branch diverged from `main`, check both directions: `base=main ref=HEAD` and `base=HEAD ref=main`. If both directions have commits, it diverged; if only one direction has commits, it is ahead or behind. When the user asks what commits are present or wants commit subjects, prefer `log`; `rev_list` is for counts and topology.

Use `ls_files` to list files tracked in the current checkout. Use `ls_tree` with `ref=<branch-or-tag>` to check whether a file exists on another branch, tag, or historical ref.

The `path` argument is always relative to the Git repository root, for example `src/app.ts` or `config/application.properties`. It is not an absolute path, not relative to an arbitrary current directory, and not a basename search. A bare filename such as `application.properties` is only valid as `path` if that exact file is tracked at the repository root.

If a user asks about a bare filename or partial path, first resolve the tracked path with `read_only_git` itself: call `ls_files` without `path` and match the basename or suffix, or use `grep` when searching tracked content. Do not use generic `ls`, `find`, `grep`, or shell commands for Git/history questions. After resolving the file, use the exact repository-relative path in `diff_name_status`, `diff`, `log`, or `show`. For “did FILE change between A and B?” questions, prefer `diff_name_status` or `diff` with `base=A`, `ref=B`, and the resolved `path=FILE`. If a path-scoped diff returns no output for a resolved repository-relative path, answer that the file did not change and do not repeat the same call.
