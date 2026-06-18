from pathlib import Path

from tutu_sync.modules.base import SyncModule


class OpenCodeModule(SyncModule):
    name = "opencode"
    config_paths = [Path(".config/opencode")]
    secret_patterns = ["**/auth.json", "**/credentials*", "**/*.key"]

    def pre_sync(self) -> None:
        pass

    def post_sync(self) -> None:
        pass
