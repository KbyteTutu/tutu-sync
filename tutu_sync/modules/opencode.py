from pathlib import Path

from tutu_sync.modules.base import SyncModule


class OpenCodeModule(SyncModule):
    name = "opencode"
    config_paths = [Path(".config/opencode")]
    secret_patterns = ["**/auth.json", "**/credentials*", "**/*.key"]
    exclude_patterns = ["**/node_modules/**", "**/.git/**", "**/*.bak-*"]

    def pre_sync(self) -> None:
        pass

    def post_sync(self) -> None:
        pass
