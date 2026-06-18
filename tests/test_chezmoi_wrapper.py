import subprocess
from unittest.mock import Mock, patch

import pytest

from tutu_sync.chezmoi_wrapper import (
    ChezmoiError,
    chezmoi_add,
    chezmoi_git,
    chezmoi_is_initialized,
    chezmoi_source_path,
    chezmoi_version,
    run_chezmoi,
)


class TestRunChezmoi:
    def test_successful_command(self):
        result = run_chezmoi(["--version"])
        assert "chezmoi version" in result.stdout

    def test_chezmoi_version(self):
        version = chezmoi_version()
        assert version.startswith("chezmoi version")

    def test_chezmoi_source_path(self):
        path = chezmoi_source_path()
        assert ".local/share/chezmoi" in path

    def test_chezmoi_not_found(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            with pytest.raises(ChezmoiError, match="chezmoi is not installed"):
                run_chezmoi(["--version"])

    def test_command_failure(self):
        with pytest.raises(ChezmoiError):
            run_chezmoi(["nonexistent-command-xyz"])

    def test_chezmoi_is_initialized(self):
        assert chezmoi_is_initialized() in (True, False)

    def test_chezmoi_add_args(self):
        mock_run = Mock()
        mock_run.return_value = subprocess.CompletedProcess([], 0, "ok", "")
        with patch("tutu_sync.chezmoi_wrapper.subprocess.run", mock_run):
            chezmoi_add("/tmp/test", encrypt=True, template=True)
            call_args = mock_run.call_args[0][0]
            assert "--encrypt" in call_args
            assert "--template" in call_args

    def test_chezmoi_git(self):
        mock_run = Mock()
        mock_run.return_value = subprocess.CompletedProcess([], 0, "ok", "")
        with patch("tutu_sync.chezmoi_wrapper.subprocess.run", mock_run):
            chezmoi_git(["status"])
            call_args = mock_run.call_args[0][0]
            assert "git" in call_args
            assert "--" in call_args
            assert "status" in call_args
