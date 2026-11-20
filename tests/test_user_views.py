"""Exercise personal view persistence through the trusted workbench gateway."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from server import make_handler
from sop import user_views
from sop.gateway import GatewayConfig
from sop.store import SOPStore, TZ, ValidationError
from tests.test_portal_gateway import KEY, ORIGIN, RefreshStub, frame_headers, request


ALICE = "EXAMPLE\\alice"
BOB = "EXAMPLE\\bob"
PATH = "/sop/api/user-views"


class UserViewsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="sop-view-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        config = self.root / "shared_config.py"
        config.write_text("MERGE_GROUPS = {}\n", encoding="utf-8")
        patcher = patch.dict("os.environ", {"SOP_SHARED_CONFIG": str(config)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = self.open_store()
        self.addCleanup(self.store.close)

    def open_store(self):
        return SOPStore(self.root / "test.sqlite3", self.root / "sales.json",
                        lambda: datetime(2026, 11, 19, 12, tzinfo=TZ))

    @contextmanager
    def running(self, *, gateway=True, console_user=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        cfg = GatewayConfig("/sop", ORIGIN, KEY, True) if gateway else None
        server.RequestHandlerClass = make_handler(
            self.store, self.root, server.server_port, source_refresh=RefreshStub(),
            gateway=cfg, console_user=console_user,
        )
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_gateway_uses_the_authenticated_account_for_every_operation(self):
        with self.running() as server:
            def call(account, payload=None, path=PATH):
                status, _, content = request(
                    server, path, method="GET" if payload is None else "POST",
                    body=payload, headers=frame_headers(account),
                )
                return status, json.loads(content)

            empty = {"active": "", "views": []}
            self.assertEqual(call(ALICE), (200, empty))
            self.assertEqual(call(None)[0], 403)
            save = {"action": "save", "name": "日常", "config": {"showLocks": True}}
            self.assertEqual(call(ALICE, {**save, "owner": BOB})[0], 400)
            self.assertEqual(call(None, save)[0], 403)
            status, first = call(ALICE, save)
            self.assertEqual(status, 200)
            alice_id = first["active"]
            self.assertEqual(first["id"], alice_id)
            self.assertEqual(call(ALICE.upper())[1], {k: first[k] for k in ("active", "views")})
            self.assertEqual(call(BOB, path=PATH+"?account=EXAMPLE%5Calice"), (200, empty))
            self.assertEqual(call(BOB, {"action": "select", "id": alice_id})[0], 400)
            self.assertEqual(call(BOB, {"action": "delete", "id": alice_id})[0], 400)
            status, second = call(BOB, {**save, "config": {"showLocks": False}})
            self.assertEqual(status, 200)
            self.assertNotEqual(second["id"], alice_id)
            self.assertTrue(call(ALICE)[1]["views"][0]["config"]["showLocks"])
            self.assertFalse(call(BOB)[1]["views"][0]["config"]["showLocks"])
            self.assertEqual(call(ALICE, {"action": "delete", "id": alice_id}), (200, empty))
            self.assertEqual(call(BOB)[1]["active"], second["id"])

            # Distinct non-ASCII account names must not be joined by Unicode expansion.
            non_ascii = "EXAMPLE\\groß"
            call(non_ascii, save)
            self.assertEqual(call("EXAMPLE\\gross"), (200, empty))

    def test_standalone_browser_headers_do_not_become_an_account(self):
        save = {"action": "save", "name": "本地", "config": {}}
        with self.running(gateway=False) as server:
            path = "/api/user-views"
            self.assertEqual(request(server, path)[0], 403)
            self.assertEqual(request(server, path, method="POST", body=save, headers={"Origin": None})[0], 403)
        with self.running(gateway=False, console_user=BOB) as server:
            status, _, _ = request(server, path, method="POST", body=save, headers={"Origin": None})
            self.assertEqual(status, 200)
        self.assertEqual(user_views.get_views(self.store, ALICE)["views"], [])
        self.assertEqual(len(user_views.get_views(self.store, BOB)["views"]), 1)

    def test_concurrent_tabs_merge_different_views_and_reload_from_database(self):
        other_store = self.open_store()
        self.addCleanup(other_store.close)

        def save(store, name):
            return user_views.update_views(store, ALICE, {"action": "save", "name": name, "config": {"query": name}})

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(save, store, name) for store, name in [(self.store, "甲"), (other_store, "乙")]]
            a, b = [future.result() for future in futures]
        reopened = self.open_store()
        self.addCleanup(reopened.close)
        result = user_views.get_views(reopened, ALICE)
        self.assertEqual({view["id"] for view in result["views"]}, {a["id"], b["id"]})
        self.assertIn(result["active"], {a["id"], b["id"]})
        self.assertEqual(save(self.store, "甲")["id"], a["id"])
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)

    def test_import_only_adds_missing_names_and_respects_existing_selection(self):
        def import_views(principal=ALICE, *, active="legacy-a"):
            return user_views.update_views(self.store, principal, {
                "action": "import", "active": active,
                "views": [{"id": "legacy-a", "name": "本地甲", "config": {"showLocks": True}},
                          {"id": "legacy-b", "name": "本地乙", "config": {"showLocks": True}}],
            })

        first = import_views()
        self.assertEqual(first["imported"], 2)
        self.assertEqual(first["active"], first["views"][0]["id"])
        self.assertNotEqual(first["active"], "legacy-a")
        edited = user_views.update_views(self.store, ALICE, {
            "action": "save", "name": "本地乙", "config": {"showLocks": False},
        })
        self.assertEqual(edited["id"], first["views"][1]["id"])
        repeated = import_views()
        self.assertEqual(repeated["imported"], 0)
        self.assertEqual(repeated["active"], edited["id"])
        self.assertFalse(repeated["views"][1]["config"]["showLocks"])
        user_views.update_views(self.store, ALICE, {"action": "select", "id": ""})
        self.assertEqual(import_views()["active"], "")
        bob = import_views(BOB, active="legacy-b")
        self.assertEqual(bob["active"], bob["views"][1]["id"])
        self.assertTrue(bob["views"][1]["config"]["showLocks"])

    def test_too_many_views_in_import_rolls_back_all_rows(self):
        user_views.update_views(self.store, ALICE, {"action": "save", "name": "日常", "config": {}})
        before = user_views.get_views(self.store, ALICE)
        with patch("sop.user_views.MAX_VIEWS", 2):
            with self.assertRaises(ValidationError):
                user_views.update_views(self.store, ALICE, {
                    "action": "import", "active": "legacy-a",
                    "views": [{"id": "legacy-a", "name": "本地甲", "config": {}},
                              {"id": "legacy-b", "name": "本地乙", "config": {}}],
                })
        self.assertEqual(user_views.get_views(self.store, ALICE), before)
