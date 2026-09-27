"""
Read AirTag / Apple device locations from the Find My app's local cache on macOS.

The Find My app keeps a cache of everything it shows on the map in
~/Library/Caches/com.apple.findmy.fmipcore/. The cache only updates while the
Find My app is running, so refresh() opens it quietly in the background.
"""

import json
import plistlib
import subprocess
import time
from pathlib import Path

CACHE_DIR = Path.home() / "Library/Caches/com.apple.findmy.fmipcore"
CACHE_FILES = {"item": CACHE_DIR / "Items.data", "device": CACHE_DIR / "Devices.data"}


class FindMyError(Exception):
    """Something the person running the tracker needs to fix. The message is shown in the setup page."""


def refresh(wait_seconds=5):
    """Open Find My in the background (without stealing focus) so it syncs, then hide it."""
    subprocess.run(["open", "-g", "-a", "FindMy"], capture_output=True, timeout=10)
    time.sleep(wait_seconds)
    subprocess.run(
        ["osascript", "-e", 'tell application "System Events" to set visible of process "FindMy" to false'],
        capture_output=True, timeout=10,
    )


def _load(path):
    raw = path.read_bytes()
    head = raw.lstrip()[:1]
    if head in (b"[", b"{"):
        return json.loads(raw)
    if raw.startswith(b"bplist"):
        return plistlib.loads(raw)
    raise FindMyError(
        f"{path.name} is in a format this tracker can't read (it may be encrypted by a newer macOS). "
        "See 'Troubleshooting' in the README."
    )


def _parse(entry, kind):
    loc = entry.get("location") or {}
    if loc.get("latitude") is None or loc.get("longitude") is None:
        lat = lng = None
    else:
        lat, lng = float(loc["latitude"]), float(loc["longitude"])
    ts = loc.get("timeStamp") or 0
    if ts > 1e12:  # Find My stores milliseconds
        ts = ts / 1000
    role = entry.get("role") or {}
    return {
        "id": entry.get("identifier") or entry.get("id") or entry.get("baUUID") or entry.get("name"),
        "name": entry.get("name") or "Unnamed",
        "emoji": role.get("emoji") or ("📍" if kind == "item" else "💻"),
        "kind": kind,
        "latitude": lat,
        "longitude": lng,
        "accuracy": loc.get("horizontalAccuracy"),
        "timestamp": float(ts) if ts else None,
        "address": entry.get("address") or {},
    }


def list_items():
    """Everything Find My knows about: AirTags/items first, then Apple devices."""
    if not CACHE_DIR.exists():
        raise FindMyError(
            "Find My's cache folder doesn't exist. Open the Find My app once, make sure you're signed in to iCloud, "
            "and check that your AirTag shows up under 'Items'."
        )
    results, problems = [], []
    for kind, path in CACHE_FILES.items():
        if not path.exists():
            continue
        try:
            data = _load(path)
        except PermissionError:
            raise FindMyError(
                "macOS blocked access to Find My's cache. Give Terminal 'Full Disk Access' in "
                "System Settings > Privacy & Security > Full Disk Access, then quit and reopen Terminal."
            )
        except FindMyError as e:
            problems.append(str(e))
            continue
        if not isinstance(data, list):
            problems.append(f"{path.name} doesn't contain a list of items (it may be encrypted by a newer macOS). See 'Troubleshooting' in the README.")
            continue
        results.extend(_parse(e, kind) for e in data if isinstance(e, dict))
    if not results and problems:
        raise FindMyError(problems[0])
    return results


def find(item_id, name=None):
    """Find the chosen AirTag, by its stable id first and then by name (names can be edited in Find My)."""
    items = list_items()
    for it in items:
        if item_id and it["id"] == item_id:
            return it
    if name:
        for it in items:
            if it["name"].strip().lower() == name.strip().lower():
                return it
    return None
