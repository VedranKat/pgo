# pgo

Dockerized Pi runner for local projects.

- Pi runs only inside Docker.
- Workspaces mount read-only by default.
- Container root is read-only by default.
- Default Pi tools: `read`, `grep`, `find`, `ls`, `read_only_git`.
- API keys are read from macOS Keychain, not repo files.

## Setup

Run from a fresh clone:

```sh
scripts/install_pgo.sh
scripts/build_pi_docker.sh
scripts/add_pgo_provider.sh
scripts/add_pgo_project.sh
```

Order:

1. `install_pgo.sh`: installs `pgo`, creates `~/.config/pgo/projects.conf`, updates shell PATH.
2. `build_pi_docker.sh`: builds `pgo-runtime:latest`.
3. `add_pgo_provider.sh`: asks for base URL, model ID, and API key; stores the key in Keychain.
4. `add_pgo_project.sh`: adds a project nickname and workspace path.

Rotate the stored key later:

```sh
scripts/add_pgo_key.sh
```

## Run

```sh
pgo PROJECT_NICKNAME
```

## Skills

Project skills live in the workspace:

```text
your-project/
  .pgo/
    skills/
      review.md
```

If `.pgo/skills` exists, pgo loads it on every run. No Docker rebuild needed.

Disable project skills for one run:

```sh
pgo PROJECT_NICKNAME --no-project-skills
```

Global Pi skill discovery stays disabled.

## Safety

- Pi is not installed or run on the host Mac.
- Workspace writes are blocked unless `--write` is passed.
- Shell is not available to Pi by default.

## Config

```sh
pgo config
```

Shows the config path, runner, provider/model, Keychain item status, and projects. It never prints the API key.
