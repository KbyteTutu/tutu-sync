from unittest.mock import Mock, patch

from click.testing import CliRunner

from tutu_sync.cli import main


class TestCLI:
    def test_help(self):
        runner = CliRunner()
        result = runner.invoke(main, ["--help"])
        assert result.exit_code == 0
        assert "sync" in result.output
        assert "daemon" in result.output
        assert "status" in result.output
        assert "list" in result.output

    def test_version(self):
        runner = CliRunner()
        result = runner.invoke(main, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.output

    def test_list(self):
        runner = CliRunner()
        result = runner.invoke(main, ["list"])
        assert result.exit_code == 0
        assert "opencode" in result.output
        assert "piagent" in result.output

    def test_sync_help(self):
        runner = CliRunner()
        result = runner.invoke(main, ["sync", "--help"])
        assert result.exit_code == 0
        assert "MODULE_NAME" in result.output
        assert "--dry-run" in result.output

    def test_pull_help(self):
        runner = CliRunner()
        result = runner.invoke(main, ["pull", "--help"])
        assert result.exit_code == 0
        assert "MODULE_NAME" in result.output

    def test_daemon_help(self):
        runner = CliRunner()
        result = runner.invoke(main, ["daemon", "--help"])
        assert result.exit_code == 0
        assert "--interval" in result.output
        assert "--once" in result.output

    def test_status(self):
        runner = CliRunner()
        result = runner.invoke(main, ["status"])
        assert result.exit_code in (0, 1)

    def test_sync_unknown_module(self):
        runner = CliRunner()
        result = runner.invoke(main, ["sync", "nonexistent"])
        assert result.exit_code == 1

    def test_sync_dry_run(self):
        runner = CliRunner()
        result = runner.invoke(main, ["sync", "opencode", "--dry-run"])
        assert result.exit_code == 0
