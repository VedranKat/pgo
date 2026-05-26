# pgo

`pgo` is a small terminal launcher for Dockerized Pi.

It lets each user keep local project nicknames and model settings outside this repo, while storing API keys in macOS Keychain.

## Install Locally

From a fresh clone:

```sh
scripts/install_pgo.sh
```

The installer links `pgo` into `$HOME/bin`, creates `~/.config/pgo/projects.conf` if it does not exist, and points the config back to the clone you ran it from.

Project paths, base URL, and model settings live in:

```text
~/.config/pgo/projects.conf
```

If `$HOME/bin` is not on your shell `PATH`, add it:

```sh
export PATH="$HOME/bin:$PATH"
```

For zsh, put that line in `~/.zshrc`.

Manual install is also possible:

Copy the launcher:

```sh
mkdir -p "$HOME/bin"
ln -sf "$(pwd)/templates/pgo" "$HOME/bin/pgo"
chmod +x "$HOME/bin/pgo"
```

Make sure `$HOME/bin` is on your shell `PATH`.

Copy the config:

```sh
mkdir -p "$HOME/.config/pgo"
cp templates/projects.conf.example "$HOME/.config/pgo/projects.conf"
```

Edit:

```text
~/.config/pgo/projects.conf
```

Set `runner` to this repo's `scripts/run_pi_docker.sh`, then add your named projects.
Add a provider with `scripts/add_pgo_provider.sh` before running pgo; it asks for the matching API key and stores it in Keychain.

## Store API Key

Provider setup asks for the API key and stores it in macOS Keychain.
To rotate the stored key later:

```sh
scripts/add_pgo_key.sh
```

The key is not stored in this repo, the Docker image, or the config file.

## Configure Provider

Set or replace the default OpenAI-compatible base URL and model:

```sh
scripts/add_pgo_provider.sh
```

The helper writes provider settings to `~/.config/pgo/projects.conf`, then asks for the provider API key and stores it in macOS Keychain. Re-running it replaces the current default provider settings and can update the stored key.

By default, pgo uses the Keychain label `pgo_ak` for the API key. The provider helper does not ask about Keychain labels unless you pass advanced command-line options.

## Add Projects

Add or update a project nickname:

```sh
scripts/add_pgo_project.sh
```

The helper asks for a nickname and a workspace path, shows path examples, validates that the directory exists, and writes `project.NAME = PATH` to your config.

The installer does not add any default projects. Run `scripts/add_pgo_project.sh` for each workspace you want to launch by nickname.

## Project Skills

pgo loads workspace skills from `.pgo/skills` and `.agents/skills` when either directory exists:

```text
your-project/
  .pgo/
    skills/
      review.md
  .agents/
    skills/
      review/
        SKILL.md
```

The skills live in the project on your Mac and are mounted read-only into Docker with the workspace. For `.agents/skills`, pgo loads directories that contain `SKILL.md`. Global Pi skill discovery remains disabled, so pgo does not load unrelated host skills. If both directories define the same skill name, `.pgo/skills` takes precedence because pgo passes it to Pi first. Use `--no-project-skills` to disable both project skill directories for a run.

## Use

List projects:

```sh
pgo --list
```

Launch Pi for a named project:

```sh
pgo PROJECT_NICKNAME
```

Launch Pi for a direct path:

```sh
pgo /path/to/repo
```

Pass runner options after the project:

```sh
pgo PROJECT_NICKNAME --no-project-skills
```

Pass Pi args after `--`:

```sh
pgo PROJECT_NICKNAME -- -p "Summarize this project"
```
