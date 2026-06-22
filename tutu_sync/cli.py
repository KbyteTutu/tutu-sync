import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import click

from tutu_sync import __version__
from tutu_sync.config import CONFIG_DIR, get_pi_sync_pass_encrypted, get_ssh_config, init_default_config, save_config
from tutu_sync.modules.registry import get_module, list_modules
from tutu_sync.sync_engine import ensure_chezmoi_initialized, sync_push, sync_pull, SyncError


@click.group()
@click.version_option(version=__version__, prog_name="tutu-sync")
def main() -> None:
    pass


@main.command("list")
def list_cmd() -> None:
    modules = list_modules()
    if not modules:
        click.echo("No modules registered.")
        return
    click.echo("Available modules:")
    for name in modules:
        m = get_module(name)
        paths = [str(p) for p in m.config_paths]
        click.echo(f"  {name:12s}  paths: {', '.join(paths)}")


@main.command("sync")
@click.argument("module_name", required=True)
@click.option("--recipient", "-r", multiple=True, help="Age recipient for encryption")
@click.option("--identity", "-i", help="Age identity file for decryption")
@click.option("--dry-run", is_flag=True, help="Preview without making changes")
@click.option("--repo", help="Git repo URL for chezmoi (required for first run)")
def sync_cmd(
    module_name: str,
    recipient: tuple[str, ...],
    identity: Optional[str],
    dry_run: bool,
    repo: Optional[str],
) -> None:
    if repo:
        ensure_chezmoi_initialized(repo)

    try:
        module = get_module(module_name)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)

    recipients = list(recipient) if recipient else None

    try:
        click.echo(f"Pushing {module.name} configs...")
        sync_push(module, identity=identity, recipients=recipients, dry_run=dry_run)
        click.echo(f"Synced {module.name} successfully.")
    except SyncError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)


@main.command("pull")
@click.argument("module_name", required=True)
@click.option("--identity", "-i", help="Age identity file for decryption")
@click.option("--dry-run", is_flag=True, help="Preview without making changes")
def pull_cmd(
    module_name: str,
    identity: Optional[str],
    dry_run: bool,
) -> None:
    try:
        module = get_module(module_name)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)

    try:
        click.echo(f"Pulling {module.name} configs...")
        sync_pull(module, identity=identity, dry_run=dry_run)
        click.echo(f"Pulled {module.name} successfully.")
    except SyncError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)


@main.command("status")
@click.argument("module_name", required=False)
def status_cmd(module_name: Optional[str]) -> None:
    from tutu_sync.chezmoi_wrapper import chezmoi_status

    if module_name:
        try:
            get_module(module_name)
        except ValueError as e:
            click.echo(f"Error: {e}", err=True)
            raise SystemExit(1)
        click.echo(f"Status for {module_name}:")

    try:
        output = chezmoi_status()
        if output.strip():
            click.echo(output)
        else:
            click.echo("No changes detected.")
    except Exception as e:
        click.echo(f"Error checking status: {e}", err=True)
        raise SystemExit(1)


@main.command("daemon")
@click.option("--interval", type=int, default=60, help="Polling interval in seconds (default: 60)")
@click.option("--once", is_flag=True, help="Check once and exit")
def daemon_cmd(interval: int, once: bool) -> None:
    from tutu_sync.daemon import poll_and_sync

    poll_and_sync(interval=interval, once=once)


@main.command("install-service")
def install_service_cmd() -> None:
    user_systemd_dir = Path.home() / ".config" / "systemd" / "user"
    unit_path = user_systemd_dir / "tutu-sync-daemon.service"

    user_systemd_dir.mkdir(parents=True, exist_ok=True)

    unit_content = f"""[Unit]
Description=tutu-sync config sync daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={sys.executable} -m tutu_sync.cli daemon
Restart=on-failure
RestartSec=30
Environment=HOME={Path.home()}
Environment=XDG_CONFIG_HOME={Path.home() / '.config'}
Environment=PATH={os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}

[Install]
WantedBy=default.target
"""

    unit_path.write_text(unit_content)
    click.echo(f"Service file written to {unit_path}")

    try:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "tutu-sync-daemon.service"], check=True)
        subprocess.run(["systemctl", "--user", "start", "tutu-sync-daemon.service"], check=True)
        click.echo("Service installed and started.")
        click.echo("Check status: systemctl --user status tutu-sync-daemon")
    except subprocess.CalledProcessError as e:
        click.echo(f"systemctl failed: {e}. Is systemd user service available?", err=True)
        click.echo(f"Manual: systemctl --user enable --now {unit_path}")
    except FileNotFoundError:
        click.echo("systemctl not found. Service file written but not activated.")
        click.echo(f"Enable manually: systemctl --user enable --now tutu-sync-daemon")


@main.command("init-ssh")
def init_ssh_cmd() -> None:
    config = init_default_config()
    ssh = config.get("ssh", {})

    if not ssh.get("host") or not ssh.get("user"):
        click.echo("SSH config is incomplete. Edit ~/.config/tutu-sync/config.yaml first:", err=True)
        click.echo(f"  ssh.host: {ssh.get('host', '(not set)')}", err=True)
        click.echo(f"  ssh.user: {ssh.get('user', '(not set)')}", err=True)
        raise SystemExit(1)

    host = ssh["host"]
    user = ssh["user"]
    port = ssh.get("port", 22)
    key_name = ssh.get("key_name", "id_ed25519_tutu")

    ssh_dir = Path.home() / ".ssh"
    config_path = ssh_dir / "config"
    ssh_dir.mkdir(mode=0o700, exist_ok=True)

    existing_keys = [
        (ssh_dir / "id_ed25519", "default ED25519"),
        (ssh_dir / "id_rsa", "default RSA"),
        (ssh_dir / key_name, f"configured ({key_name})"),
    ]

    key_path = None
    pub_path = None
    for candidate, label in existing_keys:
        pub = ssh_dir / f"{candidate.name}.pub"
        if candidate.exists() and pub.exists():
            click.echo(f"Using existing {label} key: {candidate}")
            key_path = candidate
            pub_path = pub
            break

    if key_path is None:
        key_path = ssh_dir / key_name
        pub_path = ssh_dir / f"{key_name}.pub"
        click.echo(f"Generating ED25519 key pair: {key_path}")
        result = subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-f", str(key_path), "-N", "", "-C", f"tutu-sync@{Path.home().name}"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            click.echo(f"ssh-keygen failed: {result.stderr}", err=True)
            raise SystemExit(1)
        click.echo("Key generated.")

    click.echo(f"Copying public key to {user}@{host}:{port} ...")
    result = subprocess.run(
        ["ssh-copy-id", "-i", str(pub_path), "-p", str(port), f"{user}@{host}"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        click.echo(f"ssh-copy-id warning: {result.stderr.strip()}")
    else:
        click.echo("Public key copied.")

    host_block = (
        f"\nHost tutu-sync\n"
        f"    HostName {host}\n"
        f"    User {user}\n"
        f"    Port {port}\n"
        f"    IdentityFile {key_path}\n"
        f"    IdentitiesOnly yes\n"
    )

    if config_path.exists():
        existing = config_path.read_text()
        if "Host tutu-sync" in existing:
            click.echo("SSH config already has 'tutu-sync' entry. Skipping.")
        else:
            with open(config_path, "a") as f:
                f.write(host_block)
            click.echo(f"Added 'tutu-sync' entry to {config_path}")
    else:
        config_path.write_text(host_block)
        config_path.chmod(0o600)
        click.echo(f"Created {config_path} with 'tutu-sync' entry")

    click.echo("\nDone. You can now use:")
    click.echo("  tutu-sync sync opencode --repo tutu-sync:~/tutu-configs.git")


@main.command("init-config")
def init_config_cmd() -> None:
    init_default_config()
    click.echo(f"Config initialized at {CONFIG_DIR / 'config.yaml'}")
    click.echo("Edit it to set your SSH host and user, then run:")
    click.echo("  tutu-sync init-ssh")


@main.command("init-pi")
@click.option("--install", is_flag=True, help="Clone and install pi-sync-extension")
@click.option("--recipient", "-r", required=True, help="Age recipient for encrypting pi-sync password")
def init_pi_cmd(install: bool, recipient: str) -> None:
    from tutu_sync.modules.piagent import PiAgentModule

    module = PiAgentModule()

    if install or not module.is_extension_installed():
        click.echo("Installing pi-sync-extension...")
        try:
            output = module.install_extension()
            click.echo(output)
        except RuntimeError as e:
            click.echo(f"Failed: {e}", err=True)
            raise SystemExit(1)

    encrypted = get_pi_sync_pass_encrypted()
    if encrypted:
        click.echo("pi-sync password already configured.")
    else:
        password = module.setup_password(recipient)
        click.echo(f"pi-sync password generated and encrypted.")

    if not module.is_extension_installed():
        click.echo("pi-sync-extension not found. Run 'tutu-sync init-pi --install' to set it up.")
        raise SystemExit(1)

    click.echo("Running initial pi-sync export...")
    try:
        output = module.export_config()
        click.echo(output.strip())
    except Exception as e:
        click.echo(f"Export failed: {e}")
        raise SystemExit(1)

    click.echo("\nDone. Pi config will be synced via pi-sync-extension.")


@main.command("serve")
@click.option("--port", type=int, default=8080, help="Port to listen on (default: 8080)")
def serve_cmd(port: int) -> None:
    from tutu_sync.server import run_server
    run_server(port=port)


if __name__ == "__main__":
    main()
