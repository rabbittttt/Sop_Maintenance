import base64
import http.client
import io
import json
import tempfile
import threading
import unittest
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook, load_workbook

from server import make_handler
from sop import demand
from sop.store import SOPStore, TZ, ValidationError


class DemandTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.rules = self.root / 'rules.py'
        self.rules.write_text('MERGE_GROUPS = {}', encoding='utf-8')
        rule_patch = patch.dict('os.environ', {'SOP_SHARED_CONFIG': str(self.rules)})
        rule_patch.start()
        self.addCleanup(rule_patch.stop)
        self.store = SOPStore(self.root / 'store.sqlite3', self.root / 'sales.json',
                              lambda: datetime(2026, 11, 17, 12, tzinfo=TZ))
        self.addCleanup(self.store.close)

    def test_export_limit_counts_annual_columns_before_recording_baseline(self):
        body = {"months": ["2026-12"], "models": [{"brand": "A", "model": "B"}]}
        with patch("sop.export.MAX_QUANTITY_CELLS", 1), self.assertRaises(ValidationError):
            demand.export_content(self.store, body)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM demand_export_baselines").fetchone()[0], 0)

    def table(self, rows, headers=None):
        book = Workbook()
        sheet = book.active
        sheet.title = '要货计划'
        sheet.append(headers or ['品牌', '车型', '2026-11', '2026-12'])
        for row in rows:
            sheet.append(row)
        content = io.BytesIO()
        book.save(content)
        book.close()
        return content.getvalue()

    def test_import_is_independent_sparse_and_replay_safe(self):
        content = self.table([['智界', '未来车 2027款', 100, 0], ['享界', '新车 2027款', 80, 20]])
        first = demand.import_content(self.store, content, base_revision=0, owner='张三')
        self.assertEqual((first['imported'], first['created']), (4, 2))
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM plans').fetchone()[0], 0)
        self.assertEqual(len(self.store.state()['demand_plans']), 4)
        self.assertEqual(len(self.store.state()['products']), 2)
        second = demand.import_content(self.store, content, base_revision=0, owner='张三')
        self.assertTrue(second['replayed'])
        change = self.table([['智界', '未来车 2027款', 120, None]])
        demand.import_content(self.store, change, base_revision=first['demand_revision'], owner='李四')
        values = {(row['model'], row['month']): row['quantity'] for row in demand.state(self.store)['demand_plans']}
        self.assertEqual(values[('未来车 2027款', '2026-11')], 120)
        self.assertEqual(values[('未来车 2027款', '2026-12')], 0)
        self.assertEqual(values[('新车 2027款', '2026-12')], 20)
        snapshot = self.store.manual_snapshot('核对')
        self.assertEqual(len(snapshot['demand_plans']), 4)

    def test_summary_and_members_export_only_direct_inputs(self):
        self.rules.write_text("MERGE_GROUPS = {'智界 全新 2027款汇总': ['智界 A 2027款', '智界 B 2027款']}", encoding='utf-8')
        self.store.read_sales()
        demand.import_content(self.store, self.table([
            ['智界', 'A 2027款', 10, 2], ['智界', 'B 2027款', 20, 3],
        ]), base_revision=0, owner='张三')
        content, _ = demand.export_content(self.store, {'months': ['2026-11', '2026-12']})
        workbook = load_workbook(io.BytesIO(content))
        sheet = workbook.active
        model_rows = {sheet.cell(row, 2).value: row for row in range(3, sheet.max_row + 1)}
        self.assertIn('全新 2027款', model_rows)
        self.assertIsNone(sheet.cell(model_rows['全新 2027款'], 3).value)
        self.assertEqual(sheet.cell(model_rows['A 2027款'], 3).value, 10)
        self.assertEqual(sheet.cell(model_rows['B 2027款'], 3).value, 20)
        workbook.close()
        before = len(self.store._catalog_items())
        result = demand.import_content(self.store, content, base_revision=demand.revision(self.store), owner='李四')
        self.assertEqual((result['imported'], result['created']), (0, 0))
        self.assertEqual(len(self.store._catalog_items()), before)

    def test_stale_import_and_invalid_workbook_do_not_partially_write(self):
        first = demand.import_content(self.store, self.table([['智界', '未来车 2027款', 100, 0]]), base_revision=0, owner='张三')
        stale = demand.import_content(self.store, self.table([['智界', '未来车 2027款', 500, 0]]), base_revision=0, owner='李四')
        self.assertEqual(stale['status'], 'conflict')
        for invalid in (1.5, -1, '=1+1'):
            with self.assertRaises(ValidationError):
                demand.import_content(self.store, self.table([['智界', '未来车 2027款', 999, 0],
                    ['尚界', '新车 2027款', invalid, None]]), base_revision=first['demand_revision'], owner='李四')
        self.assertEqual(demand.state(self.store)['demand_plans'][0]['quantity'], 100)
        self.assertEqual(len(self.store.state()['products']), 1)

    def test_export_is_editable_roundtrip_and_full_year_total(self):
        demand.import_content(self.store, self.table([['智界', 'R7 2026款', 3000, 10], ['智界', 'S7 2026款', 0, None]]), base_revision=0, owner='张三')
        content, name = demand.export_content(self.store, {'months': ['2026-12']})
        self.assertEqual(name, '要货计划.xlsx')
        workbook = load_workbook(io.BytesIO(content))
        sheet = workbook['要货计划']
        self.assertEqual(sheet['D2'].value, '2026总计')
        self.assertEqual(sheet['D3'].value, 3010)
        self.assertIn('A3:A4', [str(item) for item in sheet.merged_cells.ranges])
        self.assertFalse(sheet.protection.sheet)
        self.assertEqual(sheet['C3'].number_format, '0')
        sheet['C3'] = 40
        stream = io.BytesIO()
        workbook.save(stream)
        workbook.close()
        result = demand.import_content(self.store, stream.getvalue(), base_revision=demand.revision(self.store), owner='李四')
        self.assertTrue(result['ok'])
        self.assertEqual(result['imported'], 1)

    def test_mixed_metric_import_only_reads_demand(self):
        result = demand.import_content(self.store, self.table([
            ['智界', 'R7 2026款', 'SOP计划量', 999],
            ['智界', 'R7 2026款', '要货计划', 100],
            ['智界', 'R7 2026款', '锁单数', 5],
        ], headers=['品牌', '车型', '指标', '2026-11']), base_revision=0, owner='张三')
        self.assertEqual(result['imported'], 1)
        self.assertEqual(demand.state(self.store)['demand_plans'][0]['quantity'], 100)

    def test_old_export_unchanged_cells_preserve_new_values_and_changed_cells_conflict(self):
        first = demand.import_content(self.store, self.table([['智界', 'R7 2026款', 10, 20]]), base_revision=0, owner='张三')
        exported, _ = demand.export_content(self.store, {'months': ['2026-11', '2026-12']})
        demand.import_content(self.store, self.table([['智界', 'R7 2026款', 50, None]]), base_revision=first['demand_revision'], owner='李四')
        book = load_workbook(io.BytesIO(exported))
        book.active['D3'] = 30
        edited = io.BytesIO()
        book.save(edited)
        result = demand.import_content(self.store, edited.getvalue(), base_revision=demand.revision(self.store), owner='张三')
        self.assertEqual(result['imported'], 1)
        quantities = {row['month']: row['quantity'] for row in demand.state(self.store)['demand_plans']}
        self.assertEqual(quantities, {'2026-11': 50, '2026-12': 30})
        book.active['C3'] = 99
        bad_edit = io.BytesIO()
        book.save(bad_edit)
        book.close()
        conflict = demand.import_content(self.store, bad_edit.getvalue(), base_revision=demand.revision(self.store), owner='张三')
        self.assertEqual(conflict['status'], 'conflict')
        self.assertTrue(conflict['reload_workbook'])
        self.assertEqual(conflict['conflicts'][0]['database'], 50)

    def test_http_import_export_and_revision(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), BaseHTTPRequestHandler)
        server.RequestHandlerClass = make_handler(self.store, self.root, server.server_port, console_user='DOMAIN\\worker')
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=15)
            body = {'filename': '要货计划.xlsx', 'content_base64': base64.b64encode(self.table([['智界', 'R7 2026款', 12, 3]])).decode(), 'base_revision': 0, 'owner': 'fake'}
            connection.request('POST', '/api/demand/import', json.dumps(body), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            result = json.loads(response.read())
            self.assertEqual(response.status, 200, result)
            connection.request('GET', '/api/state')
            response = connection.getresponse()
            state = json.loads(response.read())
            self.assertEqual(state['demand_revision'], result['demand_revision'])
            self.assertEqual(state['demand_plans'][0]['owner'], 'DOMAIN\\worker')
            connection.request('POST', '/api/demand/export', json.dumps({'months': ['2026-11']}), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            book = load_workbook(io.BytesIO(response.read()))
            self.assertEqual(book.active['C3'].value, 12)
            book.close()
            connection.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()


if __name__ == '__main__':
    unittest.main()
