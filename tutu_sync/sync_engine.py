import glob as globlib
import json
import subprocess
from pathlib import Path
from typing import Optional

from tutu_sync.chezmoi_wrapper import (
    ChezmoiError,
    chezmoi_add,
    chezmoi_apply,
    chezmoi_git,
    chezmoi_is_initialized,
    chezmoi_init_no_apply,
    chezmoi_re_add,
    chezmoi_source_path,
    chezmoi_update,
    run_chezmoi,
)
from tutu_sync.crypto import CryptoError, encrypt_file
from tutu_sync.modules.base import SyncModule


class SyncError(Exception):
    pass


def _encrypt_secrets(module: SyncModule, identity: Optional[str] = None,
                     recipients: Optional[list[str]] = None) -> list[str]:
    encrypted: list[str] = []
    for base_path in module.get_absolute_paths():
        if not base_path.exists():
            continue
        for pattern in module.secret_patterns:
            for file_path_str in globlib.iglob(str(base_path / pattern), recursive=True):
                file_path = Path(file_path_str)
                if not file_path.is_file():
                    continue
                if file_path.suffix == ".age":
                    continue
                if recipients:
                    encrypt_file(str(file_path), recipients)
                    encrypted.append(str(file_path) + ".age")
    return encrypted


def _add_files_to_chezmoi(module: SyncModule) -> None:
    managed_raw = run_chezmoi(["managed", "--format=json"], check=False)
    managed_paths: set[str] = set()
    try:
        managed_list = json.loads(managed_raw.stdout)
        managed_paths = {str(Path.home() / item["target"]) for item in managed_list}
    except (json.JSONDecodeError, KeyError):
        pass

    added: set[str] = set()
    for base_path in module.get_absolute_paths():
        if not base_path.exists():
            continue
        for file_path in base_path.rglob("*"):
            if not file_path.is_file():
                continue
            abs_path_str = str(file_path)
            if abs_path_str in added:
                continue
            added.add(abs_path_str)

            if abs_path_str in managed_paths:
                chezmoi_re_add(abs_path_str)
            else:
                is_encrypted = file_path.suffix == ".age"
                chezmoi_add(abs_path_str, encrypt=is_encrypted)


def _git_commit_and_push(module: SyncModule) -> None:
    chezmoi_git(["add", "-A"])
    try:
        chezmoi_git(["commit", "-m", f"tutu-sync: sync {module.name} configs"])
    except ChezmoiError:
        pass
    chezmoi_git(["push"])


def sync_push(
    module: SyncModule,
    identity: Optional[str] = None,
    recipients: Optional[list[str]] = None,
    dry_run: bool = False,
) -> bool:
    try:
        module.pre_sync()

        if hasattr(module, "export_config") and hasattr(module, "_get_password"):
            password = module._get_password(identity)
            if password is None:
                raise SyncError(
                    f"pi-sync password not set for {module.name}. Run: tutu-sync init-pi"
                )
            module.export_config(password=password)

        if recipients:
            _encrypt_secrets(module, identity=identity, recipients=recipients)

        if not dry_run:
            _add_files_to_chezmoi(module)
            _git_commit_and_push(module)

        module.post_sync()
        return True
    except (ChezmoiError, CryptoError, subprocess.SubprocessError) as e:
        raise SyncError(f"sync push failed for {module.name}: {e}") from e


def sync_pull(
    module: SyncModule,
    identity: Optional[str] = None,
    dry_run: bool = False,
) -> bool:
    try:
        module.pre_sync()

        if not dry_run:
            chezmoi_update()
            chezmoi_apply(force=True)

        if hasattr(module, "import_config") and hasattr(module, "_get_password"):
            password = module._get_password(identity)
            if password is None:
                raise SyncError(
                    f"pi-sync password not set for {module.name}. Run: tutu-sync init-pi"
                )
            module.import_config(password=password)

        module.post_sync()
        return True
    except (ChezmoiError, subprocess.SubprocessError) as e:
        raise SyncError(f"sync pull failed for {module.name}: {e}") from e


def ensure_chezmoi_initialized(repo_url: str) -> None:
    if not chezmoi_is_initialized():
        chezmoi_init_no_apply(repo_url)
