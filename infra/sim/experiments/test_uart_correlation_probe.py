# SPDX-License-Identifier: MIT
"""In-memory synthetic receipts only. No native binaries, subprocesses or PTYs."""
import copy
import hashlib
import io
import json
import unittest

import uart_correlation_probe as probe
from bounded_event_collector import Completion

BINARIES = {'chelper': '1' * 64, 'pysimulavr': '2' * 64}
START = {'run': 'synthetic', 'sources': probe.SOURCES, 'binaries': BINARIES,
         'clock_domain': 'unverified'}
CLOCK = {'monotonic_ns': 10, 'process_cpu_ns': 2, 'simulation_ticks': 20}
ENDPOINT = {'process': 'pid-start', 'fd': 4, 'generation': 'open-1', 'dev': 1,
            'ino': 2, 'rdev': 3, 'pair': 'verified-fixture-pair', 'session': 's1'}


def event(stage='host.write', payload=b'ab', actual=None, **changes):
    identity = dict(ENDPOINT, process='host' if stage.startswith('host') else 'master')
    return dict({'event': 'io', 'stage': stage, 'requested': len(payload),
                 'actual': len(payload) if actual is None else actual,
                 'errno': None, 'exception': None, 'hex': payload.hex(),
                 'before': CLOCK, 'after': CLOCK,
                 'endpoint_before': identity, 'endpoint_after': identity}, **changes)


def capture(events, start=START, footer=True, completion=None, **bounds):
    output = io.BytesIO()
    recorder = probe.Recorder(output, start)
    for item in events:
        recorder.emit(item)
    if footer:
        recorder.finish(True)
    return probe.collect(io.BytesIO(output.getvalue()),
                         completion or Completion(0, None, False, True, False),
                         BINARIES, **bounds)


class CorrelationTests(unittest.TestCase):
    def facts(self, events):
        report = capture(events)
        self.assertTrue(report['prefix_valid'], report['structural_errors'])
        return report['protocol_prefix_facts']

    def test_partial_write_and_fragmented_read_match_only_actual_bytes(self):
        facts = self.facts([event(payload=b'abcd', actual=2),
                            event('master.read', b'a'), event('master.read', b'b')])
        self.assertEqual(facts['matches'][0]['status'], 'equal-observed-prefix')
        self.assertEqual(facts['matches'][0]['left_bytes'], 2)
        self.assertEqual(facts['matches'][0]['right_bytes'], 2)
        self.assertEqual(facts['native_identity'], 'unverified')
        self.assertEqual(facts['call_coverage'], 'unverified')

    def test_reverse_direction_and_mismatch(self):
        facts = self.facts([event('master.write'), event('host.read', b'ax')])
        self.assertEqual(facts['matches'][1]['status'], 'different-observed-prefix')
        self.assertEqual(facts['silence'], 'not-established')

    def test_error_and_zero_do_not_establish_silence(self):
        facts = self.facts([event(actual=-1, errno=11, exception='OSError'),
                            event('master.read', b'')])
        self.assertEqual(facts['matches'][0]['status'], 'not-observed')
        self.assertEqual(facts['matches'][0]['left_bytes'], 0)

    def test_endpoint_reuse_or_change_prevents_match(self):
        original = event()
        changed = copy.deepcopy(original)
        changed['endpoint_before']['generation'] = 'open-2'
        changed['endpoint_after']['generation'] = 'open-2'
        for events in [[original, changed, event('master.read', b'abab')],
                       [dict(original, endpoint_after=dict(ENDPOINT, ino=99))]]:
            self.assertEqual(self.facts(events)['matches'][0]['status'], 'incomplete')

    def test_session_isolation_and_payload_truncation(self):
        other = event('master.read')
        other['endpoint_before'] = other['endpoint_after'] = dict(
            other['endpoint_before'], session='s2')
        facts = self.facts([event(), other])
        self.assertTrue(all(m['status'] == 'not-observed' for m in facts['matches']))
        long = event(payload=b'x' * 64, requested=65, actual=65)
        self.assertEqual(self.facts([long])['matches'][0]['status'], 'incomplete')

    def test_clock_nulls_and_regression(self):
        missing = dict.fromkeys(CLOCK)
        facts = self.facts([event(before=missing, after=missing)])
        self.assertEqual(facts['clock_null_values_in_prefix'], 6)
        self.assertEqual(facts['clock_alignment'], 'unverified')
        self.assertFalse(capture([event(after=dict(CLOCK, monotonic_ns=9))])['prefix_valid'])
        self.assertFalse(capture([event(), event(before=dict(CLOCK, monotonic_ns=9))])['prefix_valid'])

    def test_start_source_binary_gates(self):
        for start in [dict(START, sources={}), dict(START, binaries={}),
                      dict(START, binaries=dict(BINARIES, chelper='3' * 64))]:
            self.assertFalse(capture([], start=start)['prefix_valid'])
        data = b'original synthetic bytes'
        expected = hashlib.sha256(data).hexdigest()
        self.assertEqual(probe.verify_bytes(io.BytesIO(data), expected), expected)
        for expected_hash, limit in [('0' * 64, 100), (None, 100), (expected, 1)]:
            with self.assertRaises(ValueError):
                probe.verify_bytes(io.BytesIO(data), expected_hash, limit)
        with self.assertRaises(ValueError):
            probe.verify_sources({})
        with self.assertRaises(ValueError):
            probe.verify_sources({name: io.BytesIO(b'unreviewed synthetic source')
                                  for name in probe.SOURCES})
        with self.assertRaises(ValueError):
            probe.validate_prefix(io.StringIO(''), {})

    def test_adapter_preserves_partial_return_error_object_and_one_call(self):
        records, calls = [], []
        result = bytearray(b'a')
        def read(fd, count):
            calls.append((fd, count))
            return result
        observed = probe.observe_io('master.read', read, 4, 64,
                                    lambda fd: ENDPOINT, records.append, lambda: CLOCK)
        self.assertIs(observed, result)
        self.assertEqual(calls, [(4, 64)])
        self.assertEqual(records[0]['actual'], 1)
        self.assertEqual(records[0]['hex'], '61')
        self.assertEqual(records[0]['requested'], 64)
        error = BlockingIOError(11, 'synthetic')
        def fail(fd, data):
            calls.append((fd, data))
            raise error
        with self.assertRaises(BlockingIOError) as caught:
            probe.observe_io('master.write', fail, 4, b'xyz', lambda fd: ENDPOINT,
                             records.append, lambda: CLOCK)
        self.assertIs(caught.exception, error)
        self.assertEqual(len(calls), 2)
        self.assertEqual((records[-1]['actual'], records[-1]['errno']), (-1, 11))
        self.assertEqual(records[-1]['exception'], 'OSError')
        self.facts(records)

    def test_write_count_and_observer_failure_do_not_change_result(self):
        records = []
        result = probe.observe_io('master.write', lambda fd, data: 1, 4, b'ab',
                                  lambda fd: ENDPOINT, records.append, lambda: CLOCK)
        self.assertEqual(result, 1)
        self.assertEqual(records[0]['actual'], 1)
        def broken(*args):
            raise RuntimeError('synthetic diagnostic failure')
        self.assertEqual(probe.observe_io('master.write', lambda fd, data: 0,
                                          4, b'a', broken, broken, broken), 0)
        self.assertEqual(probe.clocks(broken, broken, broken), dict.fromkeys(CLOCK))

    def test_prefix_bounds_forced_stop_and_cut_record(self):
        completion = Completion(-9, None, True, True, False)
        report = capture([event()] * 20, footer=False, completion=completion, event_limit=1)
        self.assertTrue(report['capture_bound_drop'])
        self.assertTrue(report['footer_missing'])
        self.assertTrue(report['prefix_valid'])
        self.assertEqual(report['completion'], vars(completion))
        self.assertFalse(report['complete_stream'])
        output = io.BytesIO()
        probe.Recorder(output, START).emit(event())
        report = probe.collect(io.BytesIO(output.getvalue()[:-2]), completion, BINARIES)
        self.assertFalse(report['prefix_valid'])
        self.assertTrue(report['parser_truncated'])
        self.assertEqual(report['cause'], 'unresolved')

    def test_stage_counts_cannot_verify_mapping(self):
        events = [{'event': 'stage', 'stage': s, 'tick': 1, 'monotonic_ns': 10}
                  for s in probe.STAGES]
        facts = self.facts(events)
        self.assertEqual(facts['stage_counts_in_prefix'], dict.fromkeys(probe.STAGES, 1))
        self.assertEqual(facts['stage_mapping'], 'unverified')
        self.assertEqual(facts['matches'], [])

    def test_malformed_counts_errno_payload_endpoint_and_order(self):
        for changes in [dict(actual=3), dict(actual=True), dict(errno=11),
                        dict(actual=-1), dict(hex='zz'), dict(hex='61 62'),
                        dict(endpoint_before=None), dict(before={})]:
            self.assertFalse(capture([event(**changes)])['prefix_valid'], changes)
        output = io.BytesIO()
        r = probe.Recorder(output, START)
        r.emit(event())
        r.emit(dict(event(), index=1))  # Recorder owns the sequence, not caller.
        r.finish(True)
        text = output.getvalue().replace(b'"index": 2', b'"index": 1')
        self.assertFalse(probe.collect(io.BytesIO(text), Completion(0, None, False, True, False),
                                       BINARIES)['prefix_valid'])

    def test_sink_bounds_and_output_failure(self):
        out = io.BytesIO()
        r = probe.Recorder(out, START)
        for _ in range(4100):
            r.emit(event())
        r.finish(False)
        report = probe.collect(io.BytesIO(out.getvalue()), Completion(-9, None, True, True, False), BINARIES)
        self.assertEqual(report['producer_dropped_events'], 6)
        self.assertFalse(report['complete_stream'])
        class Short:
            def write(self, data):
                return 0
        self.assertTrue(probe.Recorder(Short(), START).failed)


if __name__ == '__main__':
    unittest.main()
