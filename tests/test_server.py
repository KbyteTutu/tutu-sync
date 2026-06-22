import json
from http.server import HTTPServer
from socket import socket
from threading import Thread
from unittest.mock import patch

from tutu_sync.server import SyncHandler, _get_managed_files, _get_status_json, _get_last_commit_info, _status_html


class TestServerFunctions:
    def test_get_last_commit_info_empty(self):
        with patch("tutu_sync.server.chezmoi_git") as mock_git:
            mock_git.return_value = "abc1234 test commit (1 hour ago)\n"
            result = _get_last_commit_info()
            assert result["ok"] is True
            assert "abc1234" in result["last_commit"]

    def test_get_last_commit_info_error(self):
        from tutu_sync.chezmoi_wrapper import ChezmoiError
        with patch("tutu_sync.server.chezmoi_git", side_effect=ChezmoiError("fail")):
            result = _get_last_commit_info()
            assert result["ok"] is False

    def test_get_managed_files(self):
        with patch("tutu_sync.server._get_managed_files") as mock:
            mock.return_value = [".config/foo", "pi-backup.age"]
            assert len(mock()) == 2

    def test_get_status_json(self):
        with patch("tutu_sync.server._get_managed_files", return_value=[]):
            with patch("tutu_sync.server._get_last_commit_info", return_value={"last_commit": "test", "ok": True}):
                result = _get_status_json()
                assert "modules" in result
                assert "opencode" in result["modules"]
                assert "piagent" in result["modules"]
                assert "managed_files" in result

    def test_status_html(self):
        with patch("tutu_sync.server._get_status_json") as mock:
            mock.return_value = {
                "modules": {
                    "opencode": {"paths": [".config/opencode"], "secrets": ["**/auth.json"]},
                    "piagent": {"paths": ["pi-backup.age"], "secrets": []},
                },
                "managed_files": [".config/opencode/opencode.jsonc"],
                "last_commit": "abc1234 test commit (1 hour ago)",
                "ok": True,
            }
            html = _status_html()
            assert "<title>tutu-sync" in html
            assert "opencode" in html
            assert "piagent" in html
            assert "abc1234" in html
            assert "Pull" in html
