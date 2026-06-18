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


def _should_exclude(file_path: Path, exclude_patterns: list[str]) -> bool:
    for pattern in exclude_patterns:
        if "node_modules" in pattern and "node_modules" in file_path.parts:
            return True
        if ".git" in pattern and ".git" in file_path.parts:
            return True
        if "*.bak-" in pattern:
            if ".bak-" in file_path.name:
                return True
    return False


def _add_single_file(
    file_path: Path, managed_paths: set[str], added: set[str], was_encrypted_this_sync: set[str]
) -> None:
    abs_path_str = str(file_path)
    if abs_path_str in added:
        return
    added.add(abs_path_str)
    if abs_path_str in managed_paths:
        chezmoi_re_add(abs_path_str)
    else:
        is_encrypted = abs_path_str in was_encrypted_this_sync
        chezmoi_add(abs_path_str, encrypt=is_encrypted)


def _add_files_to_chezmoi(module: SyncModule, encrypted_this_sync: set[str]) -> None:
    managed_raw = run_chezmoi(["managed", "--format=json"], check=False)
    managed_paths: set[str] = set()
    try:
        managed_list = json.loads(managed_raw.stdout)
        managed_paths = {str(Path.home() / item["target"]) for item in managed_list}
    except (json.JSONDecodeError, KeyError):
        pass

    added: set[str] = set()
    exclude_patterns = getattr(module, "exclude_patterns", [])
    for base_path in module.get_absolute_paths():
        if not base_path.exists():
            continue
        if base_path.is_file():
            _add_single_file(base_path, managed_paths, added, encrypted_this_sync)
        elif base_path.is_dir():
            for file_path in base_path.rglob("*"):
                if not file_path.is_file():
                    continue
                if _should_exclude(file_path, exclude_patterns):
                    continue
                _add_single_file(file_path, managed_paths, added, encrypted_this_sync)


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
            module.export_config(password=password)

        encrypted_paths: set[str] = set()
        if recipients:
            encrypted_paths = set(_encrypt_secrets(module, identity=identity, recipients=recipients))

        if not dry_run:
            _add_files_to_chezmoi(module, encrypted_paths)
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
            module.import_config(password=password)

        module.post_sync()
        return True
    except (ChezmoiError, subprocess.SubprocessError) as e:
        raise SyncError(f"sync pull failed for {module.name}: {e}") from e


def ensure_chezmoi_initialized(repo_url: str) -> None:
    if not chezmoi_is_initialized():
        chezmoi_init_no_apply(repo_url)
