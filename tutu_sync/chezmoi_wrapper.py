import subprocess
from typing import Optional


class ChezmoiError(Exception):
    pass


def run_chezmoi(
    args: list[str], check: bool = True, timeout: int = 30
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["chezmoi", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise ChezmoiError(
            "chezmoi is not installed. Install it from https://www.chezmoi.io/install/"
        )

    if check and result.returncode != 0:
        raise ChezmoiError(
            f"chezmoi {' '.join(args)} failed (exit {result.returncode}): {result.stderr.strip()}"
        )

    return result


def chezmoi_version() -> str:
    return run_chezmoi(["--version"]).stdout.strip()


def chezmoi_add(
    path: str, encrypt: bool = False, template: bool = False
) -> str:
    args = ["add"]
    if encrypt:
        args.append("--encrypt")
    if template:
        args.append("--template")
    args.append(path)
    return run_chezmoi(args).stdout


def chezmoi_re_add(path: str) -> str:
    return run_chezmoi(["re-add", path]).stdout


def chezmoi_apply(force: bool = True) -> str:
    args = ["apply"]
    if force:
        args.append("--force")
    return run_chezmoi(args).stdout


def chezmoi_update() -> str:
    return run_chezmoi(["update"]).stdout


def chezmoi_status() -> str:
    return run_chezmoi(["status"]).stdout


def chezmoi_git(args: list[str]) -> str:
    return run_chezmoi(["git", "--", *args]).stdout


def chezmoi_source_path() -> str:
    return run_chezmoi(["source-path"]).stdout.strip()


def chezmoi_managed(format: str = "json") -> str:
    return run_chezmoi(["managed", f"--format={format}"]).stdout


def chezmoi_unmanaged(format: str = "json") -> str:
    return run_chezmoi(["unmanaged", f"--format={format}"]).stdout


def chezmoi_data(format: str = "json") -> str:
    return run_chezmoi(["data", f"--format={format}"]).stdout


def chezmoi_init(repo_url: str, apply: bool = True) -> str:
    args = ["init", repo_url]
    if apply:
        args.append("--apply")
    return run_chezmoi(args, timeout=120).stdout


def chezmoi_init_no_apply(repo_url: str) -> str:
    return run_chezmoi(["init", repo_url], timeout=120).stdout


def chezmoi_is_initialized() -> bool:
    try:
        chezmoi_source_path()
        return True
    except ChezmoiError:
        return False
