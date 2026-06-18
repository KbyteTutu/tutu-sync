import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from tutu_sync.config import (
    ConfigError,
    _deep_merge,
    get_pi_sync_pass_encrypted,
    get_ssh_config,
    init_default_config,
    load_config,
    save_config,
    set_pi_sync_pass_encrypted,
)
import tutu_sync.config as config_module


class TestConfig:
    @pytest.fixture(autouse=True)
    def setup_teardown(self, monkeypatch):
        tmp = Path(tempfile.mkdtemp())
        config_dir = tmp / "tutu-sync"
        config_dir.mkdir(parents=True)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_dir / "config.yaml")
        yield
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    def test_init_default_config(self):
        config = init_default_config()
        assert config_module.CONFIG_PATH.exists()
        assert config["ssh"]["port"] == 22
        assert config["ssh"]["key_name"] == "id_ed25519_tutu"

    def test_init_default_config_idempotent(self):
        c1 = init_default_config()
        c2 = init_default_config()
        assert c1 == c2

    def test_save_and_load_config(self):
        data = {
            "ssh": {
                "host": "192.168.1.100",
                "user": "pi",
                "port": 2222,
                "key_name": "my_key",
            },
            "modules": {
                "opencode": {"enabled": True},
                "piagent": {"enabled": False},
            },
        }
        save_config(data)
        loaded = load_config()
        assert loaded["ssh"]["host"] == "192.168.1.100"
        assert loaded["ssh"]["port"] == 2222
        assert loaded["modules"]["opencode"]["enabled"] is True
        assert loaded["modules"]["piagent"]["enabled"] is False

    def test_load_config_nonexistent(self):
        assert not config_module.CONFIG_PATH.exists()
        config = load_config()
        assert config["ssh"]["port"] == 22

    def test_get_ssh_config(self):
        save_config({
            "ssh": {"host": "10.0.0.1", "user": "ubuntu", "port": 22, "key_name": "id_ed25519_tutu"},
        })
        ssh = get_ssh_config()
        assert ssh["host"] == "10.0.0.1"
        assert ssh["user"] == "ubuntu"

    def test_load_invalid_yaml(self):
        config_module.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        config_module.CONFIG_PATH.write_text("invalid: [yaml: :")
        with pytest.raises(ConfigError, match="invalid YAML"):
            load_config()

    def test_deep_merge(self):
        base = {"a": 1, "b": {"c": 2, "d": 3}}
        override = {"b": {"c": 99}, "e": 4}
        _deep_merge(base, override)
        assert base["a"] == 1
        assert base["b"]["c"] == 99
        assert base["b"]["d"] == 3
        assert base["e"] == 4

    def test_pi_sync_pass_encrypted(self):
        assert get_pi_sync_pass_encrypted() is None
        set_pi_sync_pass_encrypted("encrypted-value-123")
        assert get_pi_sync_pass_encrypted() == "encrypted-value-123"
        loaded = load_config()
        assert loaded["modules"]["piagent"]["pi_sync_pass_encrypted"] == "encrypted-value-123"

    def test_pi_sync_pass_persists(self):
        set_pi_sync_pass_encrypted("persistent-pass")
        assert get_pi_sync_pass_encrypted() == "persistent-pass"
        set_pi_sync_pass_encrypted("new-pass")
        assert get_pi_sync_pass_encrypted() == "new-pass"
