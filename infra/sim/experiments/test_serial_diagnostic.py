# SPDX-License-Identifier: MIT
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import serial_diagnostic as diagnostic


class SerialDiagnosticTests(unittest.TestCase):
    def observe(self, responses=(), stats="bytes_write=40 bytes_read=0 bytes_invalid=0",
                success=False):
        events = []

        class Reader:
            serialqueue = object()

            def _start_session(self):
                for requested, offset, data in responses:
                    self.response = {"offset": offset, "data": data}
                    self.send_with_response(
                        f"identify offset={requested} count=40", "identify_response"
                    )
                if not success:
                    self.disconnect()
                return success

            def send_with_response(self, message, response):
                return self.response

            def stats(self, now):
                self.assert_live = self.serialqueue is not None
                return stats

            def disconnect(self):
                self.serialqueue = None

        diagnostic.install_observer(Reader, events.append, clock=lambda: 1.0)
        reader = Reader()
        self.assertEqual(reader._start_session(), success)
        if not success:
            self.assertTrue(reader.assert_live)
            self.assertIsNone(reader.serialqueue)
        return diagnostic.analyze(events)["sessions"][0]

    def test_silent_counter_observation_remains_inconclusive(self):
        result = self.observe()
        self.assertEqual(result["classification"], "inconclusive-no-identification-progress")
        self.assertNotIn("raw_bytes_read", result)

    def test_malformed_or_bad_sequence_cannot_be_disambiguated(self):
        result = self.observe(stats="bytes_write=40 bytes_read=0 bytes_invalid=7")
        self.assertEqual(result["classification"],
                         "inconclusive-invalid-or-sequence-rejected-traffic")

    def test_partial_valid_response_advances_contiguous_bytes(self):
        result = self.observe(((0, 0, b"abcd"), (4, 4, b"ef")))
        self.assertEqual(result["classification"], "valid-incomplete-identification")
        self.assertEqual(result["accepted_bytes"], 6)

    def test_unmatched_response_does_not_advance_bytes(self):
        result = self.observe(((0, 4, b"abcd"),))
        self.assertEqual(result["classification"], "inconclusive-unmatched-responses")
        self.assertEqual(result["accepted_bytes"], 0)

    def test_identification_completion_is_not_readiness(self):
        result = self.observe(((0, 0, b"abcd"), (4, 4, b"")), success=True)
        self.assertEqual(result["classification"], "identification-complete-not-readiness")

    def test_terminal_response_without_success_is_inconclusive(self):
        result = self.observe(((0, 0, b"abcd"), (4, 4, b"")))
        self.assertEqual(result["classification"], "inconclusive-dictionary-not-loaded")

    def test_ack_only_is_not_silent(self):
        result = self.observe(stats="bytes_write=40 bytes_read=5 bytes_invalid=0")
        self.assertEqual(result["classification"], "inconclusive-no-identification-progress")

    def test_capture_without_end_is_inconclusive(self):
        result = diagnostic.analyze([{"event": "start", "session": 1}])
        self.assertEqual(result["sessions"][0]["classification"],
                         "inconclusive-incomplete-capture")

    def test_failed_counter_capture_still_disconnects(self):
        result = self.observe(stats="bytes_invalid=unavailable")
        self.assertTrue(result["observer_error"])
        self.assertEqual(result["classification"], "inconclusive-incomplete-capture")

    def test_session_without_start_is_inconclusive(self):
        result = diagnostic.analyze([
            {"event": "identify", "session": 1, "requested": 0, "offset": 0,
             "length": 4},
            {"event": "result", "session": 1, "success": False},
        ])
        self.assertEqual(result["sessions"][0]["classification"],
                         "inconclusive-incomplete-capture")

    def test_session_counters_do_not_mix(self):
        result = diagnostic.analyze([
            {"event": "start", "session": 1},
            {"event": "identify", "session": 1, "requested": 0, "offset": 0,
             "length": 4},
            {"event": "result", "session": 1, "success": False},
            {"event": "start", "session": 2},
            {"event": "result", "session": 2, "success": False},
        ])
        self.assertEqual(result["sessions"][0]["accepted_bytes"], 4)
        self.assertEqual(result["sessions"][1]["accepted_bytes"], 0)

    def test_capture_cap_marks_every_session_inconclusive(self):
        output = io.StringIO()
        emit = diagnostic.Emitter(output)
        with patch.object(diagnostic, "MAX_EVENTS", 2):
            emit({"event": "start", "session": 1})
            emit({"event": "result", "session": 1, "success": False})
            emit({"event": "start", "session": 2})
            emit({"event": "start", "session": 3})
        self.assertEqual(len(output.getvalue().splitlines()), 3)
        result = diagnostic.analyze(diagnostic.read_events(io.StringIO(output.getvalue())))
        self.assertTrue(result["truncated"])
        self.assertEqual(result["sessions"][0]["classification"],
                         "inconclusive-incomplete-capture")

    def test_malformed_input_rejected(self):
        for record in ([], {"event": "identify", "session": 1, "requested": True,
                            "offset": 0, "length": 2}):
            with self.subTest(record=record), self.assertRaises(ValueError):
                diagnostic.analyze(diagnostic.read_events(
                    io.StringIO(diagnostic.PREFIX + json.dumps(record) + "\n")))

    def test_oversized_line_rejected(self):
        with self.assertRaisesRegex(ValueError, "bound"):
            diagnostic.read_events(io.StringIO("x" * 65537))

    def test_unrelated_logs_ignored(self):
        self.assertEqual(diagnostic.read_events(io.StringIO("ordinary log\n")), [])

    def test_modified_source_rejected_before_import(self):
        with patch.object(Path, "open", return_value=io.BytesIO(b"modified")):
            with self.assertRaisesRegex(ValueError, "incompatible source"):
                diagnostic.verify_source(Path("/synthetic"))

    def test_output_failure_does_not_retry(self):
        class BrokenOutput:
            def write(self, value):
                raise OSError("closed")

        emit = diagnostic.Emitter(BrokenOutput())
        emit({"event": "start", "session": 1})
        emit({"event": "start", "session": 2})
        self.assertTrue(emit.failed)
        self.assertEqual(emit.count, 1)


if __name__ == "__main__":
    unittest.main()
