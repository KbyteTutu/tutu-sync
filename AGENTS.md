# AGENTS.md — tutu-sync

> Last updated: 2026-06-18.

## Repo Identity

- **Remote**: `https://github.com/KbyteTutu/tutu-sync.git`
- **Language**: Python 3.10+
- **Type**: Personal config sync CLI tool wrapping chezmoi + git + age encryption

## Commands

```bash
# Dev setup (use venv — system Python is externally managed)
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Run tests
pytest tests/ -v

# Run single test file
pytest tests/test_crypto.py -v

# First-time setup (interactive)
tutu-sync init-config      # creates ~/.config/tutu-sync/config.yaml
# edit config.yaml with your SSH host/user
tutu-sync init-ssh          # generates key, ssh-copy-id, writes ~/.ssh/config
tutu-sync init-pi -r <age-recipient> --install  # set up pi-sync-extension

# Start web server
tutu-sync serve              # HTTP server on :8080 (status page + pull API)
tutu-sync serve --port 9090

# CLI usage
tutu-sync --help
tutu-sync list
tutu-sync sync opencode --dry-run
tutu-sync daemon --once
```

## Architecture

```
tutu-sync/
├── pyproject.toml          # setuptools, entry_points for module discovery
├── tutu_sync/
│   ├── cli.py              # click CLI: sync, pull, daemon, status, list, init-ssh, init-config, init-pi, install-service
│   ├── config.py           # YAML config (~/.config/tutu-sync/config.yaml)
│   ├── chezmoi_wrapper.py  # subprocess wrapper around chezmoi binary
│   ├── crypto.py           # age encryption via pyrage (x25519)
│   ├── sync_engine.py      # orchestration: encrypt → chezmoi add → git push
│   ├── daemon.py           # polling daemon: git fetch → compare → auto-pull
│   ├── server.py           # HTTP server: status page + pull API
│   ├── modules/
│   │   ├── base.py         # SyncModule ABC (name, config_paths, secret_patterns)
│   │   ├── registry.py     # module discovery via importlib entry_points
│   │   ├── opencode.py     # ~/.config/opencode/ sync module
│   │   └── piagent.py      # ~/.pi/agent/ sync via pi-sync-extension export/import
│   └── utils/
│       └── distro.py       # (Phase 2) apt/dnf detection placeholder
└── tests/
    ├── test_crypto.py
    ├── test_chezmoi_wrapper.py
    ├── test_modules.py
    ├── test_cli.py
    ├── test_cli_config.py
    ├── test_config.py
    ├── test_server.py
    └── test_sync_engine.py
```

**Data flow**: `sync push` → encrypt secrets (age) → chezmoi add/re-add → git commit → git push
**Daemon flow**: poll git remote → if upstream has new commits → `chezmoi update` + `chezmoi apply`
**Module system**: Entry points in pyproject.toml (`tutu_sync.modules` group). Each module declares paths and secret patterns.

## Conventions

- No module-level docstrings on `__init__.py` (placeholders only)
- CLI framework: click (not typer, not argparse)
- Encryption: age via pyrage Rust bindings (NOT pure Python implementations)
- Sync daemon: polling git remote (NOT inotify/watchfiles). Compares commit timestamps.
- chezmoi interaction: subprocess.run with `shell=False` — no official Python bindings exist
- Module interface: ABC with `name`, `config_paths`, `secret_patterns`, `pre_sync()`, `post_sync()`
- Tests use pytest + pytest-mock

## Gotchas

- **System Python is externally managed**: Always use `.venv`. Never `pip install` without `--break-system-packages` or a venv.
- **pyrage API**: `encrypt()` needs `pyrage.x25519.Recipient` objects, not plain strings. Use `Recipient.from_str()`.
- **LSP false positives**: `pyrage` import errors are LSP not seeing `.venv/`. Runtime resolution works correctly.
- **chezmoi prerequisite**: The `chezmoi` binary must be on `$PATH`. Install via `sh -c "$(curl -fsLS get.chezmoi.io)"`.
- **Module discovery**: Relies on `pip install -e .` registering entry_points. Without editable install, `discover_modules()` returns empty dict.
- **`.age` file suffix**: crypto.py appends `.age` to encrypted files (e.g., `auth.json.age`). Decryption strips it.
- **Pi Agent uses pi-sync-extension**: PiAgentModule wraps `sync.sh export/import` instead of directly syncing individual files. The encrypted archive (`~/pi-backup.age`) is what gets chezmoi-tracked. The pi-sync password is stored age-encrypted in config.yaml under `modules.piagent.pi_sync_pass_encrypted`.
