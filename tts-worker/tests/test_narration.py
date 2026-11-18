"""Run: cd tts-worker && python -m unittest discover -s tests   (no ML needed)"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from narration import journey_lines, lines_to_record, narration_hash, normalize_line, split_chunks  # noqa: E402

# Same vector as src/tests/narration.test.ts: the API finds recordings by this hash.
VECTOR_TEXT = "  Register at the   front desk. "
VECTOR_HASH = "dad87f584876ad6b1309cb51f720512a4ac209d8b774e38338c994c195c61d2a"


class HashTests(unittest.TestCase):
    def test_vector_matches_the_api(self):
        self.assertEqual(narration_hash(VECTOR_TEXT, "af_heart"), VECTOR_HASH)

    def test_spacing_does_not_matter_but_words_and_voice_do(self):
        self.assertEqual(normalize_line(VECTOR_TEXT), "Register at the front desk.")
        self.assertEqual(narration_hash("a  b"), narration_hash(" a b "))
        self.assertNotEqual(narration_hash("Pay here."), narration_hash("Pay here!"))
        self.assertNotEqual(narration_hash("Pay here.", "af_heart"), narration_hash("Pay here.", "bf_emma"))


class SkipTests(unittest.TestCase):
    steps = [
        {"sentences": [{"text": "Welcome."}, {"text": "   "}, {"text": "Park on the left."}]},
        {"sentences": [{"text": " Welcome. "}, {"text": "Pay here."}]},
        "not a step",
    ]

    def test_one_line_per_distinct_sentence(self):
        self.assertEqual([t for _, t in journey_lines(self.steps)], ["Welcome.", "Park on the left.", "Pay here."])
        self.assertEqual(journey_lines(None), [])

    def test_lines_with_a_recording_are_skipped(self):
        lines = journey_lines(self.steps)
        have = {narration_hash("Welcome.")}
        self.assertEqual([t for _, t in lines_to_record(lines, have)], ["Park on the left.", "Pay here."])
        self.assertEqual(lines_to_record(lines, {h for h, _ in lines}), [])

    def test_force_records_everything(self):
        lines = journey_lines(self.steps)
        self.assertEqual(len(lines_to_record(lines, {h for h, _ in lines}, force=True)), 3)

    def test_an_edited_line_needs_a_new_recording(self):
        before = {h for h, _ in journey_lines(self.steps)}
        edited = [{"sentences": [{"text": "Welcome to Riverside."}, {"text": "Pay here."}]}]
        self.assertEqual([t for _, t in lines_to_record(journey_lines(edited), before)], ["Welcome to Riverside."])


class ChunkTests(unittest.TestCase):
    def test_short_line_is_one_chunk(self):
        self.assertEqual(split_chunks("  Pay at the counter.  "), ["Pay at the counter."])
        self.assertEqual(split_chunks("   "), [])

    def test_sentences_become_chunks(self):
        self.assertEqual(split_chunks("Welcome. Bring your ID! Is this your first visit?"),
                         ["Welcome.", "Bring your ID!", "Is this your first visit?"])

    def test_long_sentences_are_cut_at_commas_then_spaces_never_mid_word(self):
        long = ("Please have your ID, your insurance card, any letters from your doctor, a list of the medicines "
                "you take, and a phone number for someone we can call, ready when you reach the desk")
        chunks = split_chunks(long, max_chars=60)
        self.assertTrue(all(len(c) <= 60 for c in chunks), chunks)
        self.assertEqual(" ".join(chunks), normalize_line(long))
        word = "x" * 30
        self.assertEqual(" ".join(split_chunks(" ".join([word] * 9), max_chars=70)), " ".join([word] * 9))

    def test_fixture_lines_fit(self):
        path = os.path.join(os.path.dirname(__file__), "..", "fixtures", "hospital-sample.json")
        with open(path) as f:
            fixture = json.load(f)
        lines = journey_lines(fixture["steps"])
        self.assertEqual(len(lines), 8)
        for _, text in lines:
            self.assertTrue(all(len(c) <= 220 for c in split_chunks(text)))


if __name__ == "__main__":
    unittest.main()
