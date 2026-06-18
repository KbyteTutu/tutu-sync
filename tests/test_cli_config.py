import subprocess
from pathlib import Path
from unittest.mock import Mock, patch

from click.testing import CliRunner

from tutu_sync.cli import main


class TestInitConfig:
    def test_init_config(self, monkeypatch, tmp_path):
        config_dir = tmp_path / "tutu-sync"
        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_dir / "config.yaml")

        runner = CliRunner()
        result = runner.invoke(main, ["init-config"])
        assert result.exit_code == 0
        assert "Config initialized" in result.output

    def test_init_config_idempotent(self, monkeypatch, tmp_path):
        config_dir = tmp_path / "tutu-sync"
        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_dir / "config.yaml")

        runner = CliRunner()
        result = runner.invoke(main, ["init-config"])
        assert result.exit_code == 0
        result = runner.invoke(main, ["init-config"])
        assert result.exit_code == 0


class TestInitSSH:
    def test_init_ssh_missing_config(self):
        runner = CliRunner()
        result = runner.invoke(main, ["init-ssh"])
        assert result.exit_code == 1
        assert "incomplete" in result.output or "invalid YAML" in result.output

    @patch("subprocess.run")
    def test_init_ssh_success(self, mock_run, monkeypatch, tmp_path):
        mock_run.return_value = subprocess.CompletedProcess([], 0, "ok", "")

        config_dir = tmp_path / "tutu-sync"
        config_dir.mkdir(parents=True)
        config_yaml = config_dir / "config.yaml"
        config_yaml.write_text("ssh:\n  host: 192.168.1.10\n  user: pi\n  port: 22\n  key_name: id_ed25519_tutu\n")

        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()

        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_yaml)

        runner = CliRunner()
        result = runner.invoke(main, ["init-ssh"])
        assert result.exit_code == 0
        assert "Generating ED25519 key pair" in result.output
        assert "Public key copied" in result.output
        assert "Done" in result.output

    @patch("subprocess.run")
    def test_init_ssh_key_exists(self, mock_run, monkeypatch, tmp_path):
        mock_run.return_value = subprocess.CompletedProcess([], 0, "ok", "")

        config_dir = tmp_path / "tutu-sync"
        config_dir.mkdir(parents=True)
        config_yaml = config_dir / "config.yaml"
        config_yaml.write_text("ssh:\n  host: 10.0.0.1\n  user: root\n  port: 22\n  key_name: existing_key\n")

        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()
        (ssh_dir / "existing_key").write_text("fake-key")
        (ssh_dir / "existing_key.pub").write_text("fake-pub")

        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_yaml)

        runner = CliRunner()
        result = runner.invoke(main, ["init-ssh"])
        assert result.exit_code == 0
        assert "Using existing" in result.output

    @patch("subprocess.run")
    def test_init_ssh_uses_default_ed25519(self, mock_run, monkeypatch, tmp_path):
        mock_run.return_value = subprocess.CompletedProcess([], 0, "ok", "")

        config_dir = tmp_path / "tutu-sync"
        config_dir.mkdir(parents=True)
        (config_dir / "config.yaml").write_text(
            "ssh:\n  host: 1.2.3.4\n  user: test\n  port: 22\n  key_name: id_ed25519_tutu\n"
        )

        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()
        (ssh_dir / "id_ed25519").write_text("default-key")
        (ssh_dir / "id_ed25519.pub").write_text("default-pub")

        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_dir / "config.yaml")

        runner = CliRunner()
        result = runner.invoke(main, ["init-ssh"])
        assert result.exit_code == 0
        assert "Using existing default ED25519" in result.output

    @patch("subprocess.run")
    def test_init_ssh_ssh_copy_id_warning(self, mock_run, monkeypatch, tmp_path):
        mock_run.side_effect = [
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 1, "", "Permission denied"),
        ]

        config_dir = tmp_path / "tutu-sync"
        config_dir.mkdir(parents=True)
        (config_dir / "config.yaml").write_text("ssh:\n  host: 1.2.3.4\n  user: test\n  port: 22\n  key_name: id_ed25519_tutu\n")

        ssh_dir = tmp_path / ".ssh"
        ssh_dir.mkdir()

        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        monkeypatch.setattr("tutu_sync.config.CONFIG_DIR", config_dir)
        monkeypatch.setattr("tutu_sync.config.CONFIG_PATH", config_dir / "config.yaml")

        runner = CliRunner()
        result = runner.invoke(main, ["init-ssh"])
        assert result.exit_code == 0
        assert "warning" in result.output
