import time
from typing import Optional

from tutu_sync.chezmoi_wrapper import (
    ChezmoiError,
    chezmoi_apply,
    chezmoi_git,
    chezmoi_update,
    run_chezmoi,
)


_DAEMON_ERROR_PREFIX = "tutu-sync daemon"


def _has_upstream_changes() -> bool:
    try:
        chezmoi_git(["fetch", "origin"])
    except ChezmoiError as e:
        print(f"{_DAEMON_ERROR_PREFIX}: git fetch failed: {e}")
        return False

    try:
        result = run_chezmoi(["git", "--", "rev-list", "--count", "HEAD..origin/main"], check=False)
        return int(result.stdout.strip()) > 0
    except (ChezmoiError, ValueError):
        return False


def poll_and_sync(interval: int = 60, once: bool = False) -> None:
    print(f"{_DAEMON_ERROR_PREFIX}: started, polling every {interval}s")
    if once:
        print(f"{_DAEMON_ERROR_PREFIX}: --once mode, checking once...")

    while True:
        if _has_upstream_changes():
            print(f"{_DAEMON_ERROR_PREFIX}: upstream has new changes, pulling...")
            try:
                chezmoi_update()
                chezmoi_apply(force=True)
                print(f"{_DAEMON_ERROR_PREFIX}: pulled and applied.")
            except ChezmoiError as e:
                print(f"{_DAEMON_ERROR_PREFIX}: pull failed: {e}")

        if once:
            break

        time.sleep(interval)
