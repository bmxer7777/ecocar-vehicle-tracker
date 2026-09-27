"""
Tests for the Mac-side tracker that don't need a Mac, Find My, or GitHub.

    python3 -m unittest discover tests

Find My is replaced by the sample cache files in tests/fixtures/ (same format the
original LYRIQ tracker read), and GitHub by a fake that records the API calls.
"""

import base64
import http.client
import json
import plistlib
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tracker"))
import findmy  # noqa: E402
import tracker  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
AIRTAG_ID = "8C1D2E3F-0000-4A1B-9C2D-3E4F5A6B7C8D"


class TempDirs(unittest.TestCase):
    """Point Find My and the tracker's files at a scratch folder for each test."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cache = self.tmp / "fmipcore"
        self.cache.mkdir()
        for name in ("Items.data", "Devices.data"):
            shutil.copy(FIXTURES / name, self.cache / name)
        live = self.tmp / "live"
        live.mkdir()
        patches = {
            (findmy, "CACHE_DIR"): self.cache,
            (findmy, "CACHE_FILES"): {"item": self.cache / "Items.data", "device": self.cache / "Devices.data"},
            (tracker, "LIVE"): live,
            (tracker, "CONFIG_FILE"): live / "config.json",
            (tracker, "HISTORY_FILE"): live / "location_history.json",
            (tracker, "SETTINGS_FILE"): self.tmp / "local_settings.json",
            (tracker, "ARCHIVE_DIR"): self.tmp / "archive",
        }
        for (mod, attr), value in patches.items():
            p = mock.patch.object(mod, attr, value)
            p.start()
            self.addCleanup(p.stop)
        refresh = mock.patch.object(findmy, "refresh", lambda *a, **k: None)
        refresh.start()
        self.addCleanup(refresh.stop)
        shutil.copy(ROOT / "data" / "config.json", tracker.CONFIG_FILE)
        tracker.write_json(tracker.HISTORY_FILE, {"locations": []})
        tracker.status.update(last_fix=None, last_publish=None, last_error=None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class FindMyCacheTests(TempDirs):
    def test_lists_airtags_and_devices(self):
        items = findmy.list_items()
        names = {i["name"]: i for i in items}
        self.assertEqual(set(names), {"ERAU Blazer", "Backpack", "Team MacBook"})
        tag = names["ERAU Blazer"]
        self.assertEqual(tag["id"], AIRTAG_ID)
        self.assertEqual(tag["emoji"], "🚙")
        self.assertEqual(tag["kind"], "item")
        self.assertAlmostEqual(tag["latitude"], 31.1968748)
        self.assertEqual(tag["timestamp"], 1770652368.0, "milliseconds should become seconds")
        self.assertEqual(tag["address"]["stateCode"], "TX")
        self.assertIsNone(names["Backpack"]["latitude"], "items with no location are listed, not dropped")
        self.assertEqual(names["Team MacBook"]["kind"], "device")

    def test_find_by_id_then_by_name(self):
        self.assertEqual(findmy.find(AIRTAG_ID)["name"], "ERAU Blazer")
        self.assertEqual(findmy.find("stale-id", "erau blazer")["id"], AIRTAG_ID, "falls back to a case-insensitive name")
        self.assertIsNone(findmy.find("nope", "nothing"))

    def test_binary_plist_cache(self):
        items = json.loads((FIXTURES / "Items.data").read_text(encoding="utf-8"))
        for it in items:  # plists can't hold None
            for k in [k for k, v in it.items() if v is None]:
                del it[k]
        (self.cache / "Items.data").write_bytes(plistlib.dumps(items, fmt=plistlib.FMT_BINARY))
        self.assertEqual(findmy.find(AIRTAG_ID)["name"], "ERAU Blazer")

    def test_encrypted_cache_gives_readable_error(self):
        (self.cache / "Items.data").write_bytes(plistlib.dumps({"encryptedData": b"\x00" * 64}, fmt=plistlib.FMT_BINARY))
        (self.cache / "Devices.data").write_bytes(b"\x93\x11garbage")
        with self.assertRaises(findmy.FindMyError) as ctx:
            findmy.list_items()
        self.assertIn("Troubleshooting", str(ctx.exception))

    def test_missing_cache_folder(self):
        shutil.rmtree(self.cache)
        with self.assertRaises(findmy.FindMyError) as ctx:
            findmy.list_items()
        self.assertIn("Open the Find My app", str(ctx.exception))

    def test_permission_denied_explains_full_disk_access(self):
        with mock.patch.object(Path, "read_bytes", side_effect=PermissionError):
            with self.assertRaises(findmy.FindMyError) as ctx:
                findmy.list_items()
        self.assertIn("Full Disk Access", str(ctx.exception))


class TrackingTests(TempDirs):
    def choose_airtag(self, **extra):
        s = tracker.load_settings()
        s.update(airtag_id=AIRTAG_ID, airtag_name="ERAU Blazer", **extra)
        tracker.save_settings(s)

    def move_airtag(self, lat, lng, ts_ms):
        items = json.loads((self.cache / "Items.data").read_text(encoding="utf-8"))
        items[0]["location"].update(latitude=lat, longitude=lng, timeStamp=ts_ms)
        (self.cache / "Items.data").write_text(json.dumps(items), encoding="utf-8")

    def test_records_new_locations_only(self):
        self.choose_airtag()
        with mock.patch.object(tracker, "publish", return_value=True) as pub:
            tracker.check_once()
            tracker.check_once()  # same fix again: ignored
            self.move_airtag(31.30, -105.10, 1770653000000)
            tracker.check_once()
        locs = tracker.load_history()["locations"]
        self.assertEqual(len(locs), 2)
        self.assertEqual((locs[1]["latitude"], locs[1]["timestamp"]), (31.30, 1770653000.0))
        self.assertEqual(locs[0]["address"]["locality"], "El Paso")
        self.assertEqual(pub.call_count, 2, "publishes once per new location")

    def test_older_fix_is_ignored(self):
        self.choose_airtag()
        with mock.patch.object(tracker, "publish", return_value=True):
            tracker.check_once()
            self.move_airtag(30.0, -100.0, 1770600000000)  # earlier than what we have
            tracker.check_once()
        self.assertEqual(len(tracker.load_history()["locations"]), 1)

    def test_renamed_airtag_still_found_by_id(self):
        self.choose_airtag()
        items = json.loads((self.cache / "Items.data").read_text(encoding="utf-8"))
        items[0]["name"] = "Blazer (renamed)"
        (self.cache / "Items.data").write_text(json.dumps(items), encoding="utf-8")
        with mock.patch.object(tracker, "publish", return_value=True):
            tracker.check_once()
        self.assertEqual(len(tracker.load_history()["locations"]), 1)

    def test_missing_airtag_sets_error(self):
        s = tracker.load_settings()
        s.update(airtag_id="gone", airtag_name="Gone Tag")
        tracker.save_settings(s)
        tracker.check_once()
        self.assertIn("isn't in Find My", tracker.status["last_error"])

    def test_new_trip_archives_and_clears(self):
        self.choose_airtag()
        with mock.patch.object(tracker, "publish", return_value=True):
            tracker.check_once()
            tracker.api_new_trip({})
        self.assertEqual(tracker.load_history()["locations"], [])
        archived = list(tracker.ARCHIVE_DIR.glob("*.json"))
        self.assertEqual(len(archived), 1)
        self.assertEqual(len(json.loads(archived[0].read_text(encoding="utf-8"))["locations"]), 1)


class FakeGitHub:
    """Records calls; answers like the GitHub API does for a repo with or without the data branch."""

    def __init__(self, branch_exists=True, remote_config=None):
        self.calls = []
        self.branch_exists = branch_exists
        self.remote_config = remote_config

    def __call__(self, method, path, token, body=None):
        self.calls.append((method, path, body))
        if method == "GET" and "/contents/config.json" in path:
            if self.remote_config is None:
                return 404, {"message": "Not Found"}
            return 200, {"content": base64.b64encode(json.dumps(self.remote_config).encode()).decode()}
        if path.endswith("/git/trees"):
            return 201, {"sha": "tree1"}
        if path.endswith("/git/commits"):
            return 201, {"sha": "commit1"}
        if method == "PATCH":
            return (200, {}) if self.branch_exists else (422, {"message": "Reference does not exist"})
        if method == "POST" and path.endswith("/git/refs"):
            return 201, {}
        return 404, {}


class PublishTests(TempDirs):
    def setUp(self):
        super().setUp()
        s = tracker.load_settings()
        s.update(repo="team/tracker", token="tok")
        tracker.save_settings(s)

    def test_publish_force_pushes_single_commit(self):
        fake = FakeGitHub()
        with mock.patch.object(tracker, "github", fake):
            self.assertTrue(tracker.publish("test"))
        methods = [(m, p.split("/git/")[-1] if "/git/" in p else p) for m, p, _ in fake.calls]
        self.assertEqual(methods[1:], [("POST", "trees"), ("POST", "commits"), ("PATCH", "refs/heads/tracker-data")])
        tree = fake.calls[1][2]["tree"]
        self.assertEqual({f["path"] for f in tree}, {"config.json", "location_history.json"})
        self.assertEqual(fake.calls[2][2]["parents"], [], "orphan commit keeps the repo small")
        self.assertTrue(fake.calls[3][2]["force"])

    def test_publish_creates_branch_first_time(self):
        fake = FakeGitHub(branch_exists=False)
        with mock.patch.object(tracker, "github", fake):
            self.assertTrue(tracker.publish())
        self.assertEqual(fake.calls[-1][:2], ("POST", "/repos/team/tracker/git/refs"))

    def test_publish_without_repo_does_nothing(self):
        s = tracker.load_settings()
        s["repo"] = ""
        tracker.save_settings(s)
        fake = FakeGitHub()
        with mock.patch.object(tracker, "github", fake):
            self.assertFalse(tracker.publish())
        self.assertEqual(fake.calls, [])

    def test_bad_token_message(self):
        with mock.patch.object(tracker, "github", lambda *a, **k: (401, {"message": "Bad credentials"})):
            self.assertFalse(tracker.publish())
        self.assertIn("rejected the token", tracker.status["last_error"])

    def test_web_edits_win_when_newer(self):
        local = tracker.read_json(tracker.CONFIG_FILE, {})
        local["updated_at"] = "2026-09-27T01:00:00+00:00"
        tracker.write_json(tracker.CONFIG_FILE, local)
        remote = dict(local, trip=dict(local["trip"], event="Y2 Competition", mode="parked"), updated_at="2026-09-27T02:00:00.000Z")
        fake = FakeGitHub(remote_config=remote)
        with mock.patch.object(tracker, "github", fake):
            tracker.publish()
        self.assertEqual(tracker.read_json(tracker.CONFIG_FILE, {})["trip"]["event"], "Y2 Competition")
        published = json.loads(next(f for f in fake.calls[1][2]["tree"] if f["path"] == "config.json")["content"])
        self.assertEqual(published["trip"]["mode"], "parked", "the Mac republishes the web edit instead of overwriting it")

    def test_older_web_copy_is_ignored(self):
        local = tracker.read_json(tracker.CONFIG_FILE, {})
        local["updated_at"] = "2026-09-27T03:00:00+00:00"
        tracker.write_json(tracker.CONFIG_FILE, local)
        remote = dict(local, trip=dict(local["trip"], event="Old"), updated_at="2026-09-27T02:00:00Z")
        with mock.patch.object(tracker, "github", FakeGitHub(remote_config=remote)):
            tracker.publish()
        self.assertNotEqual(tracker.read_json(tracker.CONFIG_FILE, {})["trip"]["event"], "Old")

    def test_parse_time_formats(self):
        self.assertEqual(tracker.parse_time("2026-09-27T02:00:00.000Z"), tracker.parse_time("2026-09-27T02:00:00+00:00"))
        self.assertEqual(tracker.parse_time(None), 0)
        self.assertEqual(tracker.parse_time("garbage"), 0)


class ServerTests(TempDirs):
    def setUp(self):
        super().setUp()
        self.server = tracker.ThreadingHTTPServer(("127.0.0.1", 0), tracker.Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        tracker.write_json(tracker.SETTINGS_FILE, {"token": "secret-token"})

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"localhost:{self.port}"}
        if body is not None:
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data, res

    def test_serves_the_page_and_data(self):
        status, body, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"settings.js", body)
        self.assertEqual(self.request("GET", "/data/teams.json")[0], 200)

    def test_never_serves_the_token_or_code(self):
        for path in ("/tracker/local_settings.json", "/tracker/tracker.py", "/.git/config", "/README.md", "/data/../tracker/tracker.py",
                     "/data/%2e%2e/tracker/local_settings.json", "/assets/..%2f..%2ftracker/local_settings.json", "/data/..\\tracker\\local_settings.json"):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        status, body, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertNotIn(b"secret-token", body)
        self.assertTrue(json.loads(body)["settings"]["token_set"])

    def test_old_setup_link_redirects_to_gear(self):
        status, _, res = self.request("GET", "/setup")
        self.assertEqual((status, res.getheader("Location")), (302, "/?settings"))

    def test_rejects_other_sites(self):
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "evil.example"})[0], 403, "DNS rebinding")
        cfg = tracker.read_json(tracker.CONFIG_FILE, {})
        self.assertEqual(self.request("POST", "/api/config", {"config": cfg}, {"Origin": "https://evil.example"})[0], 403)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/tracking", body="on=1", headers={"Host": "localhost", "Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(conn.getresponse().status, 403, "plain form posts can't reach the API")
        conn.close()

    def test_save_config_validates_and_saves(self):
        cfg = tracker.read_json(tracker.CONFIG_FILE, {})
        cfg["trip"]["mode"] = "teleporting"
        self.assertEqual(self.request("POST", "/api/config", {"config": cfg})[0], 400)
        cfg["trip"].update(mode="parked", event="Y1 Competition")
        status, body, _ = self.request("POST", "/api/config", {"config": cfg})
        self.assertEqual(status, 200)
        saved = tracker.read_json(tracker.CONFIG_FILE, {})
        self.assertEqual((saved["trip"]["mode"], saved["trip"]["event"]), ("parked", "Y1 Competition"))
        self.assertIn("updated_at", saved)

    def test_settings_validate_repo_and_keep_token_private(self):
        self.assertEqual(self.request("POST", "/api/settings", {"repo": "not a repo"})[0], 400)
        self.assertEqual(self.request("POST", "/api/settings", {"repo": "team/tracker", "interval_minutes": 500})[0], 200)
        s = tracker.load_settings()
        self.assertEqual((s["repo"], s["interval_minutes"], s["token"]), ("team/tracker", 60, "secret-token"))

    def test_items_endpoint_lists_find_my(self):
        status, body, _ = self.request("GET", "/api/items")
        self.assertEqual(status, 200)
        self.assertIn("ERAU Blazer", [i["name"] for i in json.loads(body)["items"]])


class DataFileTests(unittest.TestCase):
    def test_bundled_json_is_valid(self):
        teams = json.loads((ROOT / "data/teams.json").read_text(encoding="utf-8"))
        self.assertEqual(len(teams["teams"]), 20)
        self.assertEqual(sum(t["track"] == "gm" for t in teams["teams"]), 10)
        for t in teams["teams"]:
            self.assertRegex(t["colors"][0], r"^#[0-9A-Fa-f]{6}$", t["id"])
            self.assertTrue(-125 < t["lng"] < -70 and 25 < t["lat"] < 50, t["id"])
        cfg = json.loads((ROOT / "data/config.json").read_text(encoding="utf-8"))
        self.assertIn(cfg["trip"]["mode"], ("driving", "parked", "idle"))
        places = json.loads((ROOT / "data/places.json").read_text(encoding="utf-8"))
        self.assertTrue(places["events"])


if __name__ == "__main__":
    unittest.main()
