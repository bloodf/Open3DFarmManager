# SPDX-License-Identifier: MIT
import io
import json
import unittest

from bounded_event_collector import Collector, Completion, validate_uart_prefix
import uart_method_diagnostic as uart

CLOCK = {'monotonic_ns': 1, 'process_cpu_ns': 1, 'simulation_ticks': 1}
START = {'event': 'start', 'source_sha256': uart.SOURCE_SHA256, 'clocks': CLOCK}
WRITE = {'event': 'write', 'outcome': 'returned', 'return_type': 'NoneType',
         'before': CLOCK, 'after': CLOCK, 'argument_bytes': 1, 'argument_hex': 'aa',
         'syscall_count': None, 'delivery': 'unknown'}
END = {'event': 'end', 'normal': True, 'dropped': 0,
       'empty_reads': {'bytes': 0, 'str': 0}, 'clocks': CLOCK}


def encode(item):
    return (uart.PREFIX + json.dumps(item) + '\n').encode()


class CollectorTests(unittest.TestCase):
    def collect(self, data, completion=None, **bounds):
        collector = Collector(uart.PREFIX.encode(), **bounds)
        collector.consume(io.BytesIO(data))
        report = collector.report(completion or Completion(0, None, False, True, False),
                                  validate_uart_prefix)
        return collector, report

    def test_over_one_mib_start_survives_and_tail_cannot_replace_prefix(self):
        data = encode(START) + encode(WRITE) * 4000 + encode(END)
        self.assertGreater(len(data), 1024 * 1024)
        collector, report = self.collect(data)
        self.assertEqual(collector.header, encode(START))
        self.assertTrue(report['prefix_valid'])
        self.assertTrue(report['capture_bound_drop'])
        self.assertGreater(report['dropped_records'], 0)
        self.assertEqual(report['observed_bytes'], len(data))
        self.assertEqual(len(collector.header) + len(collector.events) + report['dropped_bytes'], len(data))
        self.assertTrue(report['normal_footer_observed'])
        self.assertFalse(report['complete_stream'])
        self.assertLessEqual(len(collector.events), 1024 * 1024)
        self.assertNotIn('capture', report['protocol_prefix_facts'])
        _, tail = self.collect(data[-1024 * 1024:])
        self.assertFalse(tail['prefix_valid'])
        self.assertIn('missing-start', tail['structural_errors'])

    def test_deliberate_forced_stop_is_partial_without_footer(self):
        # Synthetic killed-process output and independently supplied stop receipt.
        completion = Completion(-9, None, True, True, False)
        _, report = self.collect(encode(START) + encode(WRITE), completion)
        self.assertTrue(report['prefix_valid'])
        self.assertTrue(report['footer_missing'])
        self.assertFalse(report['normal_footer_observed'])
        self.assertEqual(report['completion'], vars(completion))
        self.assertEqual(report['scope'], 'observed-prefix-only')
        self.assertFalse(report['complete_stream'])
        self.assertEqual(report['delivery'], 'unknown')
        self.assertEqual(report['cause'], 'unresolved')

    def test_process_failure_not_inferred_from_footer_or_signal(self):
        for completion in [Completion(137, None, False, True, False),
                           Completion(None, 'read', False, False, True),
                           Completion(None, 'launch', False, False, False),
                           Completion(None, 'timeout', True, False, True)]:
            _, report = self.collect(encode(START), completion)
            self.assertEqual(report['completion'], vars(completion))
            self.assertTrue(report['prefix_valid'])
            self.assertFalse(report['complete_stream'])

    def test_invalid_start_order_shape_hash_and_footer(self):
        for data in [b'', encode(WRITE), encode(START) * 2,
                     encode(WRITE) + encode(START),
                     encode({**START, 'source_sha256': 'wrong'}),
                     encode({**START, 'clocks': {}}),
                     encode(START) + encode(END) + encode(WRITE),
                     encode(START) + encode({**END, 'dropped': -1}),
                     encode(START) + uart.PREFIX.encode() + b'[]\n']:
            with self.subTest(data=data[:100]):
                _, report = self.collect(data)
                self.assertFalse(report['prefix_valid'])

    def test_header_bound_and_line_truncation_are_explicit(self):
        _, report = self.collect(encode(START), header_limit=1)
        self.assertFalse(report['prefix_valid'])
        self.assertIn('header-not-retained', report['structural_errors'])
        for suffix in [encode(WRITE)[:-1], b'x' * 100000 + b'\n']:
            _, report = self.collect(encode(START) + suffix)
            self.assertTrue(report['parser_truncated'])
            self.assertFalse(report['prefix_valid'])
            self.assertTrue(report['capture_gap'])
            self.assertFalse(report['capture_bound_drop'])
            self.assertGreater(report['dropped_bytes'], 0)

    def test_duplicate_start_detected_after_capture_bound(self):
        _, report = self.collect(encode(START) + encode(WRITE) * 20 + encode(START),
                                 event_limit=1)
        self.assertEqual(report['start_count'], 2)
        self.assertFalse(report['prefix_valid'])

    def test_clock_nulls_are_facts_not_clock_health(self):
        _, report = self.collect(encode({**START, 'clocks': dict.fromkeys(CLOCK)}))
        self.assertTrue(report['prefix_valid'])
        self.assertEqual(report['protocol_prefix_facts']['clock_null_values_in_prefix'], 3)
        self.assertEqual(report['protocol_prefix_facts']['clock_health'], 'unverified')
        self.assertEqual(report['clock_alignment'], 'unverified')

    def test_record_bounds_and_invalid_method_payload(self):
        _, report = self.collect(encode(START) + encode(WRITE) * 4, record_limit=2)
        self.assertEqual(report['dropped_records'], 3)
        self.assertTrue(report['prefix_valid'])
        for change in [{'argument_hex': 'zz'}, {'syscall_count': 1},
                       {'before': {'monotonic_ns': -1}}, {'outcome': 'bogus'}]:
            _, report = self.collect(encode(START) + encode({**WRITE, **change}))
            self.assertFalse(report['prefix_valid'])

    def test_forced_stop_with_large_stream_and_cut_last_record(self):
        data = encode(START) + encode(WRITE) * 4000
        _, intact = self.collect(data, Completion(-9, None, True, True, False))
        self.assertTrue(intact['prefix_valid'])
        self.assertTrue(intact['footer_missing'])
        self.assertFalse(intact['complete_stream'])
        data += encode(WRITE)[:50]
        collector, report = self.collect(data, Completion(-9, None, True, True, False))
        self.assertEqual(collector.header, encode(START))
        self.assertTrue(report['capture_bound_drop'])
        self.assertTrue(report['parser_truncated'])
        self.assertTrue(report['footer_missing'])
        self.assertFalse(report['prefix_valid'])
        self.assertFalse(report['complete_stream'])

    def test_normal_footer_and_producer_drops_do_not_establish_completeness(self):
        for drops in [0, 5]:
            _, report = self.collect(encode(START) + encode({**END, 'dropped': drops}))
            self.assertTrue(report['prefix_valid'])
            self.assertTrue(report['footer_valid'])
            self.assertEqual(report['producer_dropped_events'], drops)
            self.assertFalse(report['complete_stream'])
        _, report = self.collect(encode(START) + encode({**END, 'dropped': -1}),
                                 event_limit=1)
        self.assertFalse(report['footer_valid'])
        self.assertFalse(report['prefix_valid'])

    def test_completion_required_and_single_use(self):
        collector = Collector(b'X ')
        with self.assertRaises(ValueError):
            collector.report(None, validate_uart_prefix)
        collector.consume(io.BytesIO(b''))
        with self.assertRaises(ValueError):
            collector.consume(io.BytesIO(b''))
        with self.assertRaises(ValueError):
            Completion(0, None, 1, True, False)


if __name__ == '__main__':
    unittest.main()
