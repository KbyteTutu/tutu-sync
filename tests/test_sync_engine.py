from unittest.mock import MagicMock, patch

import pytest

from tutu_sync.modules.opencode import OpenCodeModule
from tutu_sync.sync_engine import sync_push, sync_pull, SyncError


class TestSyncEngine:
    def test_sync_push_dry_run(self):
        module = OpenCodeModule()
        with patch("tutu_sync.sync_engine._encrypt_secrets") as mock_enc:
            with patch("tutu_sync.sync_engine._add_files_to_chezmoi") as mock_add:
                with patch("tutu_sync.sync_engine._git_commit_and_push") as mock_git:
                    result = sync_push(module, recipients=["age1test"], dry_run=True)
                    assert result is True
                    mock_enc.assert_called_once()
                    mock_add.assert_not_called()
                    mock_git.assert_not_called()

    def test_sync_push_without_recipients(self):
        module = OpenCodeModule()
        with patch("tutu_sync.sync_engine._encrypt_secrets") as mock_enc:
            with patch("tutu_sync.sync_engine._add_files_to_chezmoi") as mock_add:
                with patch("tutu_sync.sync_engine._git_commit_and_push") as mock_git:
                    result = sync_push(module, dry_run=True)
                    assert result is True
                    mock_enc.assert_not_called()

    def test_sync_pull_dry_run(self):
        module = OpenCodeModule()
        with patch("tutu_sync.sync_engine.chezmoi_update") as mock_update:
            with patch("tutu_sync.sync_engine.chezmoi_apply") as mock_apply:
                result = sync_pull(module, dry_run=True)
                assert result is True
                mock_update.assert_not_called()
                mock_apply.assert_not_called()

    def test_module_isolation(self):
        op = OpenCodeModule()
        from tutu_sync.modules.piagent import PiAgentModule
        pi = PiAgentModule()

        assert op.name != pi.name
        assert op.config_paths != pi.config_paths
