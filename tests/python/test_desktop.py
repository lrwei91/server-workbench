import os
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'cdr'))
import app


class DesktopSessionTests(unittest.TestCase):
    def test_cdr_requires_ephemeral_token_in_desktop_mode(self):
        with patch.dict(os.environ, {'CDR_SESSION_TOKEN': 'desktop-test'}):
            with TestClient(app.app) as client:
                self.assertEqual(client.get('/api/session').status_code, 403)
                self.assertEqual(client.get('/').status_code, 403)
                response = client.get('/api/session', headers={'x-cdr-token': 'desktop-test'})
                self.assertEqual(response.status_code, 200)
                self.assertIn('dirty', response.json())

    def test_browser_mode_preserved(self):
        with patch.dict(os.environ, {'CDR_SESSION_TOKEN': ''}):
            with TestClient(app.app) as client:
                self.assertEqual(client.get('/api/session').status_code, 200)


if __name__ == '__main__':
    unittest.main()
