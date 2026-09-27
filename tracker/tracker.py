#!/usr/bin/env python3
"""
EcoCAR Vehicle Tracker - the part that runs on a Mac.

    python3 tracker/tracker.py

Opens the setup page at http://localhost:8765/setup. From there you pick the AirTag,
fill in the trip, and turn tracking on. While tracking is on, this script:
  1. nudges the Find My app so its location cache stays fresh,
  2. reads the AirTag's latest position from that cache,
  3. appends new positions to data/live/location_history.json,
  4. publishes config.json + location_history.json to the repo's "tracker-data" branch,
     which the public GitHub Pages viewer reads.

Only the Python standard library is used, so there is nothing to pip install.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
import findmy  # noqa: E402

PORT = int(os.environ.get("TRACKER_PORT", "8765"))
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LIVE = DATA / "live"  # this Mac's working copy (git-ignored); data/config.json is only the starting template
CONFIG_FILE = LIVE / "config.json"
HISTORY_FILE = LIVE / "location_history.json"
SETTINGS_FILE = Path(__file__).parent / "local_settings.json"  # holds the GitHub token; never published or served
ARCHIVE_DIR = Path(__file__).parent / "archive"
SETUP_PAGE = Path(__file__).parent / "setup.html"

DEFAULT_SETTINGS = {
    "airtag_id": "",
    "airtag_name": "",
    "repo": "",
    "branch": "tracker-data",
    "token": "",
    "interval_minutes": 2,
    "tracking": False,
}

lock = threading.RLock()
wake = threading.Event()
status = {"last_fix": None, "last_check": None, "last_publish": None, "last_error": None}
log_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with lock:
        log_lines.append(line)
        del log_lines[:-200]


# ---------- files ----------

def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def load_settings():
    return {**DEFAULT_SETTINGS, **read_json(SETTINGS_FILE, {})}


def save_settings(s):
    write_json(SETTINGS_FILE, s)
    try:
        os.chmod(SETTINGS_FILE, 0o600)
    except OSError:
        pass


def load_history():
    return read_json(HISTORY_FILE, {"locations": []})


# ---------- GitHub publishing ----------

def github_token(settings):
    """The token from the setup page, or (for developers) the GitHub CLI's login."""
    if settings.get("token"):
        return settings["token"]
    if shutil.which("gh"):
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    return ""


def github(method, path, token, body=None):
    """Call the GitHub REST API with curl (uses the Mac's system certificates, unlike python.org Python)."""
    config = [
        f'url = "https://api.github.com{path}"',
        f'request = "{method}"',
        'header = "Accept: application/vnd.github+json"',
        'header = "X-GitHub-Api-Version: 2022-11-28"',
        f'header = "Authorization: Bearer {token}"',
        'silent', 'show-error',
        'write-out = "\\n%{http_code}"',
    ]
    body_file = None
    try:
        if body is not None:
            body_file = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
            json.dump(body, body_file)
            body_file.close()
            config += ['header = "Content-Type: application/json"', f'data-binary = "@{body_file.name}"']
        out = subprocess.run(["curl", "-K", "-"], input="\n".join(config), capture_output=True, text=True, timeout=60)
    finally:
        if body_file:
            os.unlink(body_file.name)
    if out.returncode != 0:
        raise RuntimeError(f"Network error talking to GitHub: {out.stderr.strip()[:200]}")
    text, _, code = out.stdout.rpartition("\n")
    code = int(code or 0)
    data = json.loads(text) if text.strip() else {}
    return code, data


def publish(reason=""):
    """Replace the tracker-data branch with a single commit holding config.json + location_history.json.

    Force-updating one orphan commit keeps the repo small no matter how many pings a trip has.
    """
    s = load_settings()
    repo, branch = s.get("repo", "").strip(), s.get("branch") or "tracker-data"
    if not repo:
        log("Not publishing: no GitHub repo set yet (Publishing section of the setup page).")
        return False
    token = github_token(s)
    if not token:
        log("Not publishing: no GitHub token set yet (Publishing section of the setup page).")
        return False
    config = read_json(CONFIG_FILE, {})
    history = load_history()
    try:
        code, tree = github("POST", f"/repos/{repo}/git/trees", token, {"tree": [
            {"path": "config.json", "mode": "100644", "type": "blob", "content": json.dumps(config, indent=2, ensure_ascii=False)},
            {"path": "location_history.json", "mode": "100644", "type": "blob", "content": json.dumps(history, indent=1, ensure_ascii=False)},
        ]})
        if code != 201:
            raise RuntimeError(explain_github_error(code, tree, repo))
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        code, commit = github("POST", f"/repos/{repo}/git/commits", token,
                              {"message": f"Tracker update {stamp}{' - ' + reason if reason else ''}", "tree": tree["sha"], "parents": []})
        if code != 201:
            raise RuntimeError(explain_github_error(code, commit, repo))
        code, _ = github("PATCH", f"/repos/{repo}/git/refs/heads/{branch}", token, {"sha": commit["sha"], "force": True})
        if code == 422 or code == 404:  # branch doesn't exist yet
            code, resp = github("POST", f"/repos/{repo}/git/refs", token, {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
            if code != 201:
                raise RuntimeError(explain_github_error(code, resp, repo))
        elif code != 200:
            raise RuntimeError(explain_github_error(code, _, repo))
    except Exception as e:  # noqa: BLE001 - shown to the user in the setup page
        status["last_error"] = str(e)
        log(f"Publish failed: {e}")
        return False
    status["last_publish"] = time.time()
    status["last_error"] = None
    log(f"Published to {repo} ({branch} branch)")
    return True


def explain_github_error(code, data, repo):
    msg = (data or {}).get("message", "")
    if code == 401:
        return "GitHub rejected the token (expired or mistyped). Make a new one; see README step 3."
    if code in (403, 404):
        return (f"GitHub says the token can't write to {repo} ({code} {msg}). Check the repo name, and that the token "
                "has 'Contents: Read and write' access to that repository.")
    return f"GitHub error {code}: {msg}"


# ---------- tracking loop ----------

def check_once():
    s = load_settings()
    if not s.get("airtag_id") and not s.get("airtag_name"):
        log("No AirTag chosen yet. Pick one in the AirTag section of the setup page.")
        return
    status["last_check"] = time.time()
    try:
        findmy.refresh()
        item = findmy.find(s.get("airtag_id"), s.get("airtag_name"))
    except findmy.FindMyError as e:
        status["last_error"] = str(e)
        log(str(e))
        return
    except Exception as e:  # noqa: BLE001
        status["last_error"] = f"Couldn't read Find My: {e}"
        log(status["last_error"])
        return
    if not item:
        status["last_error"] = f"'{s.get('airtag_name')}' isn't in Find My anymore. Pick the AirTag again."
        log(status["last_error"])
        return
    if item["latitude"] is None:
        log(f"{item['name']}: Find My has no location for it right now.")
        return

    with lock:
        history = load_history()
        locs = history.setdefault("locations", [])
        last = locs[-1] if locs else None
        is_new = not last or (
            (item["timestamp"] or 0) > (last.get("timestamp") or 0)
            and (item["latitude"], item["longitude"]) != (last.get("latitude"), last.get("longitude"))
        )
        if is_new:
            locs.append({
                "latitude": item["latitude"],
                "longitude": item["longitude"],
                "accuracy": item["accuracy"],
                "timestamp": item["timestamp"] or time.time(),
                "address": item["address"],
                "recorded_at": datetime.now().isoformat(timespec="seconds"),
            })
            history["airtag_name"] = item["name"]
            write_json(HISTORY_FILE, history)
    status["last_fix"] = item["timestamp"]
    status["last_error"] = None
    where = ", ".join(filter(None, [item["address"].get("locality"), item["address"].get("administrativeArea")]))
    if is_new:
        log(f"New location: {where or (item['latitude'], item['longitude'])}")
        publish("new location")
    else:
        log("No new location since last check")


def tracking_loop():
    while True:
        s = load_settings()
        if s.get("tracking"):
            check_once()
        wake.wait(max(1, float(s.get("interval_minutes") or 2)) * 60)
        wake.clear()


# ---------- web server ----------

PUBLIC_PREFIXES = ("/assets/", "/data/")
PUBLIC_FILES = {"/", "/index.html"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *args):  # keep the terminal readable
        pass

    def _host_ok(self):
        # Blocks DNS-rebinding: only answer requests addressed to this machine.
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("localhost", "127.0.0.1")

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if not self._host_ok():
            return self.send_error(403)
        path = urlparse(self.path).path
        if path in ("/setup", "/setup/"):
            body = SETUP_PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if path == "/api/state":
            return self._send_json(api_state())
        if path == "/api/items":
            try:
                items = findmy.list_items()
                items.sort(key=lambda i: (i["kind"] != "item", i["name"].lower()))
                return self._send_json({"items": items})
            except findmy.FindMyError as e:
                return self._send_json({"error": str(e)}, 400)
            except Exception as e:  # noqa: BLE001
                return self._send_json({"error": f"Couldn't read Find My: {e}"}, 500)
        if path in PUBLIC_FILES or path.startswith(PUBLIC_PREFIXES):
            return super().do_GET()
        self.send_error(404)

    def do_POST(self):
        if not self._host_ok() or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send_error(403)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).hostname not in ("localhost", "127.0.0.1"):
            return self.send_error(403)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send_json({"error": "Bad request"}, 400)
        path = urlparse(self.path).path
        handler = ROUTES.get(path)
        if not handler:
            return self.send_error(404)
        try:
            return self._send_json(handler(body))
        except ValueError as e:
            return self._send_json({"error": str(e)}, 400)


def api_state():
    s = load_settings()
    history = load_history()
    with lock:
        lines = list(log_lines[-60:])
    return {
        "config": read_json(CONFIG_FILE, {}),
        "settings": {k: v for k, v in s.items() if k != "token"} | {"token_set": bool(s.get("token")), "gh_cli": bool(shutil.which("gh"))},
        "status": status,
        "pings": len(history.get("locations", [])),
        "last_location": (history.get("locations") or [None])[-1],
        "log": lines,
        "public_url": public_url(s.get("repo", "")),
    }


def public_url(repo):
    m = re.fullmatch(r"([\w.-]+)/([\w.-]+)", repo or "")
    if not m:
        return ""
    owner, name = m.groups()
    return f"https://{owner.lower()}.github.io/" if name.lower() == f"{owner.lower()}.github.io" else f"https://{owner.lower()}.github.io/{name}/"


def api_save_config(body):
    config = body.get("config")
    if not isinstance(config, dict) or not isinstance(config.get("trip"), dict):
        raise ValueError("Missing trip settings")
    if config["trip"].get("mode") not in ("driving", "parked", "idle"):
        raise ValueError("Mode must be driving, parked or idle")
    s = load_settings()
    config["publish"] = {"repo": s.get("repo", ""), "branch": s.get("branch") or "tracker-data"}
    config["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    write_json(CONFIG_FILE, config)
    log(f"Trip saved: {config['trip'].get('event') or 'untitled'} ({config['trip']['mode']})")
    published = publish("trip settings changed") if s.get("repo") else False
    return {"ok": True, "published": published}


def api_save_settings(body):
    s = load_settings()
    for key in ("airtag_id", "airtag_name", "repo", "branch"):
        if key in body:
            s[key] = str(body[key]).strip()
    if s["repo"] and not re.fullmatch(r"[\w.-]+/[\w.-]+", s["repo"]):
        raise ValueError("Repo should look like owner/repo-name, e.g. erau-ecocar/vehicle-tracker")
    if "interval_minutes" in body:
        s["interval_minutes"] = max(1, min(60, int(body["interval_minutes"])))
    if body.get("token"):
        s["token"] = str(body["token"]).strip()
    if body.get("clear_token"):
        s["token"] = ""
    save_settings(s)
    config = read_json(CONFIG_FILE, {})
    config["publish"] = {"repo": s["repo"], "branch": s["branch"] or "tracker-data"}
    write_json(CONFIG_FILE, config)
    log("Settings saved")
    return {"ok": True}


def api_tracking(body):
    s = load_settings()
    s["tracking"] = bool(body.get("on"))
    save_settings(s)
    log("Tracking ON" if s["tracking"] else "Tracking OFF")
    wake.set()
    return {"ok": True, "tracking": s["tracking"]}


def api_check_now(_body):
    wake.set()
    return {"ok": True}


def api_test_publish(_body):
    ok = publish("connection test")
    return {"ok": ok, "error": None if ok else status.get("last_error")}


def api_new_trip(_body):
    with lock:
        history = load_history()
        if history.get("locations"):
            ARCHIVE_DIR.mkdir(exist_ok=True)
            event = re.sub(r"[^\w-]+", "-", (read_json(CONFIG_FILE, {}).get("trip", {}).get("event") or "trip")).strip("-")
            dest = ARCHIVE_DIR / f"{datetime.now():%Y-%m-%d_%H%M}_{event}.json"
            write_json(dest, history)
            log(f"Saved {len(history['locations'])} pings to tracker/archive/{dest.name}")
        write_json(HISTORY_FILE, {"locations": []})
    publish("new trip")
    return {"ok": True}


ROUTES = {
    "/api/config": api_save_config,
    "/api/settings": api_save_settings,
    "/api/tracking": api_tracking,
    "/api/check-now": api_check_now,
    "/api/test-publish": api_test_publish,
    "/api/new-trip": api_new_trip,
}


def main():
    if sys.platform != "darwin":
        print("Note: reading AirTags only works on a Mac. The setup page and viewer will still open so you can look around.\n")
    LIVE.mkdir(exist_ok=True)
    if not CONFIG_FILE.exists():
        shutil.copy(DATA / "config.json", CONFIG_FILE)
    if not HISTORY_FILE.exists():
        write_json(HISTORY_FILE, {"locations": []})
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is busy - the tracker is probably already running. Opening it in your browser.")
        webbrowser.open(f"http://localhost:{PORT}/setup")
        return
    threading.Thread(target=tracking_loop, daemon=True).start()
    url = f"http://localhost:{PORT}/setup"
    log(f"Tracker running. Setup page: {url}   (press Ctrl+C here to quit)")
    if load_settings().get("tracking"):
        log("Tracking was ON when the tracker last stopped, so it has resumed.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Tracker stopped.")


if __name__ == "__main__":
    main()
