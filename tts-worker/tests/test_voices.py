"""The voice list must be the same in the worker, the API and the editor.

A voice the editor offers but the image doesn't have would fail every recording
(the image is offline); one the API refuses could never be chosen.
"""
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
from narration import DEFAULT_VOICE, VOICES  # noqa: E402

API = HERE.parent / "src" / "utils" / "narration.ts"
APP = HERE.parent.parent / "viewora-app" / "shared" / "utils" / "journey.ts"


class VoicesAgree(unittest.TestCase):
    def test_api_list_matches(self):
        m = re.search(r"export const VOICES = \[([^\]]*)\]", API.read_text())
        self.assertIsNotNone(m, "VOICES not found in the API")
        self.assertEqual(tuple(re.findall(r"'([\w]+)'", m.group(1))), VOICES)

    @unittest.skipUnless(APP.exists(), "viewora-app not checked out next to the backend")
    def test_editor_list_matches_and_has_samples(self):
        src = APP.read_text()
        block = src.split("export const JOURNEY_VOICES", 1)[1].split("] as const", 1)[0]
        self.assertEqual(tuple(re.findall(r"id: '([\w]+)'", block)), VOICES)
        self.assertIn(f"DEFAULT_JOURNEY_VOICE: JourneyVoice = '{DEFAULT_VOICE}'", src)
        for v in VOICES:
            self.assertTrue((APP.parent.parent.parent / "public" / "voices" / f"{v}.mp3").exists(), f"sample for {v}")

    def test_default_is_offered(self):
        self.assertIn(DEFAULT_VOICE, VOICES)


if __name__ == "__main__":
    unittest.main()
