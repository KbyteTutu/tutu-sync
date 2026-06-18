import os
import secrets
import subprocess
from pathlib import Path
from typing import Optional

from tutu_sync.config import get_pi_sync_pass_encrypted, set_pi_sync_pass_encrypted
from tutu_sync.crypto import CryptoError, decrypt_string, encrypt_string
from tutu_sync.modules.base import SyncModule

PI_SYNC_DIR = Path.home() / ".pi" / "agent" / "extensions" / "pi-sync"
SYNC_SH = PI_SYNC_DIR / "sync.sh"
BACKUP_FILE = Path.home() / "pi-backup.age"


class PiSyncNotInstalled(Exception):
    pass


class PiAgentModule(SyncModule):
    name = "piagent"
    config_paths = [Path("pi-backup.age")]
    secret_patterns = []

    def pre_sync(self) -> None:
        pass

    def post_sync(self) -> None:
        pass

    def is_extension_installed(self) -> bool:
        return SYNC_SH.exists()

    def _get_password(self, identity: Optional[str] = None) -> Optional[str]:
        encrypted = get_pi_sync_pass_encrypted()
        if not encrypted:
            return None
        if not identity:
            return None
        try:
            return decrypt_string(encrypted, identity)
        except CryptoError:
            return None

    def _set_password(self, password: str, recipient: str) -> None:
        encrypted = encrypt_string(password, [recipient])
        set_pi_sync_pass_encrypted(encrypted)

    def _run_sync_sh(self, *args, password: Optional[str] = None) -> subprocess.CompletedProcess[str]:
        if not self.is_extension_installed():
            raise PiSyncNotInstalled(
                "pi-sync-extension not found. Run: tutu-sync init-pi --install"
            )

        env = os.environ.copy()
        if password:
            env["PI_SYNC_PASS"] = password

        return subprocess.run(
            [str(SYNC_SH), *args],
            capture_output=True, text=True, timeout=120, env=env,
        )

    def export_config(self, password: Optional[str] = None) -> str:
        result = self._run_sync_sh("export", str(BACKUP_FILE), password=password)
        if result.returncode != 0:
            raise RuntimeError(f"pi-sync export failed: {result.stderr.strip()}")
        return result.stdout

    def import_config(self, password: Optional[str] = None) -> str:
        result = self._run_sync_sh("import", str(BACKUP_FILE), password=password)
        if result.returncode != 0:
            raise RuntimeError(f"pi-sync import failed: {result.stderr.strip()}")
        return result.stdout

    def setup_password(self, recipient: str) -> str:
        password = secrets.token_hex(16)
        self._set_password(password, recipient)
        return password

    def install_extension(self) -> str:
        PI_SYNC_DIR.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["git", "clone", "https://github.com/cemmetje87/pi-sync.git", str(PI_SYNC_DIR)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0 and "already exists" not in result.stderr:
            raise RuntimeError(f"Failed to clone pi-sync: {result.stderr.strip()}")

        ext_symlink = Path.home() / ".pi" / "agent" / "extensions" / "pi-sync.ts"
        if not ext_symlink.exists():
            ext_symlink.symlink_to(PI_SYNC_DIR / "pi-sync.ts")

        if not PI_SYNC_DIR.exists():
            PI_SYNC_DIR.mkdir(parents=True)

        return f"pi-sync-extension installed at {PI_SYNC_DIR}"
