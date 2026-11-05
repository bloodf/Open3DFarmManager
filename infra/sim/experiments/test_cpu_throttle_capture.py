# SPDX-License-Identifier: MIT
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import cpu_throttle_capture as capture


class CpuThrottleCaptureTests(unittest.TestCase):
    def test_reads_required_cumulative_counters(self):
        content = 'usage_usec 12\nnr_periods 5\nnr_throttled 3\nthrottled_usec 7\nextra 9\n'
        with patch.object(Path, 'open', return_value=io.StringIO(content)):
            self.assertEqual(capture.read_counters(), {
                'usage_usec': 12, 'nr_periods': 5,
                'nr_throttled': 3, 'throttled_usec': 7,
            })

    def test_rejects_missing_duplicate_and_oversized_data(self):
        for content in ('usage_usec 1\n', 'usage_usec 1\nusage_usec 2\n', 'x' * 4097):
            with self.subTest(content=content[:20]), patch.object(
                    Path, 'open', return_value=io.StringIO(content)):
                with self.assertRaises(ValueError):
                    capture.read_counters()

    def test_capture_is_bounded_and_times_each_read(self):
        now = [100.0]
        def clock():
            return now[0]
        def sleep(delay):
            now[0] += delay
        def read():
            now[0] += 0.1
            return {'usage_usec': 10}
        output = io.StringIO()
        capture.capture(output, read=read, clock=clock, sleep=sleep)
        samples = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(samples), 90)
        self.assertEqual(samples[0]['before'], 100.0)
        self.assertAlmostEqual(samples[0]['after'], 100.1)
        self.assertEqual(samples[-1]['before'], 189.0)
        self.assertEqual(samples[-1]['counters'], {'usage_usec': 10})

    def test_slow_sampling_does_not_extend_window(self):
        now = [0.0]
        def read():
            now[0] += 50
            return {}
        output = io.StringIO()
        capture.capture(output, read=read, clock=lambda: now[0], sleep=lambda _: None)
        self.assertEqual(len(output.getvalue().splitlines()), 2)


if __name__ == '__main__':
    unittest.main()
