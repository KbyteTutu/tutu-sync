import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
from urllib.parse import urlparse

from tutu_sync.chezmoi_wrapper import ChezmoiError, chezmoi_git
from tutu_sync.modules.registry import discover_modules, get_module, list_modules
from tutu_sync.sync_engine import sync_pull


def _get_last_commit_info() -> dict:
    try:
        log = chezmoi_git(["log", "-1", "--format=%h %s (%cr)"])
        return {"last_commit": log.strip(), "ok": True}
    except ChezmoiError:
        return {"last_commit": "", "ok": False}


def _get_managed_files() -> list[str]:
    try:
        from tutu_sync.chezmoi_wrapper import run_chezmoi as _run
        raw = _run(["managed"]).stdout.strip()
        return [line for line in raw.split("\n") if line] if raw else []
    except Exception:
        return []


def _get_status_json() -> dict:
    modules = {}
    for name in list_modules():
        mod = get_module(name)
        modules[name] = {
            "paths": [str(p) for p in mod.config_paths],
            "secrets": mod.secret_patterns,
        }
    return {
        "modules": modules,
        "managed_files": _get_managed_files(),
        **_get_last_commit_info(),
    }


def _status_html() -> str:
    status = _get_status_json()
    files = "\n".join(f"      <li>{f}</li>" for f in status["managed_files"])
    modules_html = ""
    for name, info in status["modules"].items():
        modules_html += (
            f'    <tr><td>{name}</td><td>{", ".join(info["paths"])}</td>'
            f'<td><form method="post" action="/api/pull/{name}" style="display:inline">'
            f'<button>Pull</button></form></td></tr>\n'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>tutu-sync — Status</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }}
    th {{ background: #f5f5f5; }}
    button {{ padding: 4px 12px; cursor: pointer; }}
    .commit {{ color: #666; font-size: 0.9em; }}
  </style>
</head>
<body>
  <h1>tutu-sync</h1>

  <h2>Status</h2>
  <p class="commit">Last commit: {status["last_commit"] or "(none)"}</p>

  <h2>Modules</h2>
  <table>
    <tr><th>Module</th><th>Paths</th><th></th></tr>
{modules_html}
  </table>

  <h2>Managed Files ({len(status["managed_files"])})</h2>
  <ul>
{files}
  </ul>

  <form method="post" action="/api/pull">
    <button style="padding: 8px 24px; font-size: 1em;">Pull All</button>
  </form>
</body>
</html>
"""


class SyncHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html: str, status: int = 200):
        body = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/" or path == "/status":
            self._send_html(_status_html())
        elif path == "/api/status":
            self._send_json(_get_status_json())
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/pull":
            results = {}
            for name in list_modules():
                try:
                    mod = get_module(name)
                    sync_pull(mod)
                    results[name] = "ok"
                except Exception as e:
                    results[name] = str(e)
            self._send_json({"pulled": results})
        elif path.startswith("/api/pull/"):
            name = path.split("/")[-1]
            try:
                mod = get_module(name)
                sync_pull(mod)
                self._send_json({"pulled": {name: "ok"}})
            except ValueError:
                self._send_json({"error": f"unknown module: {name}"}, status=404)
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
        else:
            self._send_json({"error": "not found"}, status=404)


def run_server(port: int = 8080) -> None:
    server = HTTPServer(("0.0.0.0", port), SyncHandler)
    print(f"tutu-sync server running at http://0.0.0.0:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
