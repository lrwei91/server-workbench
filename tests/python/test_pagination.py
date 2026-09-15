import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'cdr'))
import engine


class PaginationTests(unittest.TestCase):
    def setUp(self):
        engine._session.reset()
        engine._session.filename = 'fixture.json'
        engine._session.records = [{'VALUE': i} for i in range(1000)]

    def tearDown(self):
        engine._session.reset()

    def test_unfiltered_page_does_not_scan_records(self):
        class NoScanList(list):
            def __iter__(self):
                raise AssertionError('unfiltered paging scanned all records')
        engine._session.records = NoScanList(engine._session.records)
        result = engine.get_records(page=999, page_size=30)
        self.assertEqual((result['total'], result['page']), (1000, 34))
        self.assertEqual([r['idx'] for r in result['records']], list(range(990, 1000)))

    def test_filters_preserve_indexes_and_membership_semantics(self):
        result = engine.get_records(filters=[{'field': 'VALUE', 'op': 'in', 'value': [3, 8]}])
        self.assertEqual([r['idx'] for r in result['records']], [3, 8])
        self.assertTrue(engine._match({'v': [1]}, {'field': 'v', 'op': 'in', 'value': [[1]]}))
        self.assertFalse(engine._match({'v': 1}, {'field': 'v', 'op': 'in', 'value': None}))

    def test_empty_page(self):
        engine._session.records = []
        result = engine.get_records(page=9)
        self.assertEqual((result['total'], result['page'], result['total_pages']), (0, 1, 1))
        self.assertEqual(result['records'], [])
