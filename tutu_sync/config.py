from copy import deepcopy
from pathlib import Path
from typing import Any, Optional

import yaml


CONFIG_DIR = Path.home() / ".config" / "tutu-sync"
CONFIG_PATH = CONFIG_DIR / "config.yaml"

DEFAULT_CONFIG = {
    "ssh": {
        "host": "",
        "user": "",
        "port": 22,
        "key_name": "id_ed25519_tutu",
    },
    "modules": {},
}


class ConfigError(Exception):
    pass


def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return deepcopy(DEFAULT_CONFIG)

    try:
        with open(CONFIG_PATH) as f:
            data = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        raise ConfigError(f"invalid YAML in {CONFIG_PATH}: {e}")

    result = deepcopy(DEFAULT_CONFIG)
    _deep_merge(result, data)
    return result


def save_config(data: dict[str, Any]) -> None:
    _ensure_config_dir()
    with open(CONFIG_PATH, "w") as f:
        yaml.safe_dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def init_default_config() -> dict[str, Any]:
    if CONFIG_PATH.exists():
        return load_config()

    default = deepcopy(DEFAULT_CONFIG)
    _ensure_config_dir()
    save_config(default)
    return default


def get_ssh_config() -> dict[str, Any]:
    return load_config().get("ssh", {})


def get_pi_sync_pass_encrypted() -> Optional[str]:
    config = load_config()
    modules = config.get("modules", {})
    piagent = modules.get("piagent", {})
    return piagent.get("pi_sync_pass_encrypted")


def set_pi_sync_pass_encrypted(value: str) -> None:
    config = load_config()
    modules = config.setdefault("modules", {})
    piagent = modules.setdefault("piagent", {})
    piagent["pi_sync_pass_encrypted"] = value
    save_config(config)


def _deep_merge(base: dict, override: dict) -> None:
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
