# SPDX-License-Identifier: MIT
"""Original synthetic fixtures only. No subprocess, container, firmware or device."""
import io
import hashlib
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
import json
import unittest

import session_clock_probe as probe
from bounded_event_collector import Completion


def events(output):
    return [json.loads(line[len(probe.PREFIX):]) for line in output.getvalue().splitlines()]


class ProbeTests(unittest.TestCase):
    def host(self, result=b'dictionary', raised=None):
        output = io.StringIO()
        capture = probe.Capture(output, 'host', clock=lambda: 123)
        calls = []

        class CompletionStub:
            def wait(self, *args, **kwargs):
                calls.append(('wait', args, kwargs))
                if raised:
                    raise raised
                return result

        class Reactor:
            def monotonic(self):
                return 17.125

            def register_callback(self, callback, *args, **kwargs):
                calls.append(('register', args, kwargs))
                callback(17.0)
                return CompletionStub()

        class Reader:
            def __init__(self):
                self.reactor = Reactor()

            def _get_identify_data(self, eventtime):
                calls.append(('identify', eventtime))
                return result

            def _start_session(self, *args, **kwargs):
                calls.append(('start', args, kwargs))
                completion = self.reactor.register_callback(self._get_identify_data)
                value = completion.wait(self.reactor.monotonic() + 5.)
                return value

        probe.install_host(Reader, capture)
        return Reader(), output, calls, capture

    def test_exact_wait_argument_and_original_result(self):
        sentinel = object()
        reader, output, calls, capture = self.host(sentinel)
        self.assertIs(reader._start_session('device', flag=2), sentinel)
        self.assertEqual(calls, [('start', ('device',), {'flag': 2}),
                                 ('register', (), {}), ('identify', 17.0),
                                 ('wait', (22.125,), {})])
        observed = events(output)
        self.assertEqual([e['event'] for e in observed], ['start', 'session_start',
                         'identify_start', 'identify_completion', 'identify_wait',
                         'identify_wait_completion', 'session_completion'])
        self.assertEqual(observed[4]['actual_deadline'], 22.125)
        self.assertEqual({e['session'] for e in observed[1:]}, {1})
        self.assertNotIn('register_callback', vars(reader.reactor))
        reader._start_session()
        self.assertEqual(events(output)[-1]['session'], 2)

    def test_timeout_and_exception_remain_distinct(self):
        reader, output, _, _ = self.host(None)
        self.assertIsNone(reader._start_session())
        self.assertEqual(events(output)[-2]['outcome'], 'timeout')
        failure = RuntimeError('synthetic')
        reader, output, _, _ = self.host(raised=failure)
        with self.assertRaises(RuntimeError) as caught:
            reader._start_session()
        self.assertIs(caught.exception, failure)
        self.assertEqual(events(output)[-2]['outcome'], 'raised')
        self.assertNotIn('register_callback', vars(reader.reactor))

    def test_late_callback_retains_original_session(self):
        reader, output, _, _ = self.host()
        callbacks = []

        class Pending:
            def wait(self, deadline):
                return None

        def defer(callback):
            callbacks.append(callback)
            return Pending()

        reader.reactor.register_callback = defer
        reader._start_session()
        reader._start_session()
        callbacks[0](30.)
        callbacks[1](30.)
        starts = [e['session'] for e in events(output) if e['event'] == 'identify_start']
        self.assertEqual(starts, [1, 2])
        self.assertIs(reader.reactor.register_callback, defer)

    def test_existing_reactor_override_restored(self):
        reader, _, _, _ = self.host()
        original = reader.reactor.register_callback
        reader.reactor.register_callback = original
        reader._start_session()
        self.assertIs(reader.reactor.register_callback, original)

    def test_source_mismatch_never_executes(self):
        namespace = {'__file__': 'synthetic'}
        for data, role in [(b'executed = True', 'host'), (b'x' * 65537, 'avr'), (b'', 'other')]:
            with self.assertRaises(ValueError):
                probe.load_verified(data, role, namespace)
            output = io.StringIO()
            with self.assertRaises(ValueError):
                probe.instrument_verified(data, role, namespace, output)
            self.assertEqual(output.getvalue(), '')
        self.assertEqual(namespace, {'__file__': 'synthetic'})

    def test_avr_calls_once_preserves_return_and_exception(self):
        output = io.StringIO()
        capture = probe.Capture(output, 'avr', clock=lambda: 100, raw_clock=lambda: 90)
        sentinel, failure = object(), OSError(5, 'synthetic')
        calls = []

        class Terminal:
            def read(self, arg):
                calls.append(('read', arg))
                return sentinel

            def write(self, arg):
                calls.append(('write', arg))
                raise failure

        probe.install_avr(Terminal, capture, lambda: 77)
        terminal = Terminal()
        self.assertIs(terminal.read(1), sentinel)
        with self.assertRaises(OSError) as caught:
            terminal.write(b'a')
        self.assertIs(caught.exception, failure)
        self.assertEqual(calls, [('read', 1), ('write', b'a')])
        self.assertEqual(events(output)[1], dict(event='clock_pair', monotonic_ns=100,
                         monotonic_before_ns=100, monotonic_after_ns=100, simulation_ticks=77,
                         raw_before_ns=90, raw_after_ns=90,
                         tick_raw_before_ns=90, tick_raw_after_ns=90))
        self.assertEqual(len(events(output)), 2)

    def test_clock_and_output_failure_do_not_replace_result(self):
        def broken():
            raise OSError('synthetic')
        output = io.StringIO()
        capture = probe.Capture(output, 'avr', clock=broken)

        class Terminal:
            def read(self):
                return b'ok'
            write = read

        probe.install_avr(Terminal, capture, broken)
        self.assertEqual(Terminal().read(), b'ok')
        self.assertIsNone(events(output)[1]['simulation_ticks'])
        output.close()
        self.assertEqual(Terminal().write(), b'ok')
        self.assertTrue(capture.failed)

    def test_collector_forced_stop_missing_footer(self):
        reader, output, _, _ = self.host()
        reader._start_session()
        collector, report = probe.collect(io.BytesIO(output.getvalue().encode()),
                    Completion(-9, None, True, True, False))
        self.assertTrue(report['prefix_valid'])
        self.assertTrue(report['footer_missing'])
        self.assertTrue(report['completion']['forced_stop'])
        self.assertFalse(report['complete_stream'])
        self.assertEqual(report['protocol_prefix_facts']['interval_coverage'], 'unverified')
        self.assertTrue(collector.header.startswith(probe.PREFIX.encode()))

    def test_producer_bound_and_footer(self):
        output = io.StringIO()
        capture = probe.Capture(output, 'host', clock=lambda: 1, limit=2)
        for _ in range(10):
            capture.emit('session_start', session=1)
        capture.finish(False)
        _, report = probe.collect(io.BytesIO(output.getvalue().encode()),
                                 Completion(1, None, False, True, False))
        self.assertTrue(report['prefix_valid'])
        self.assertTrue(report['footer_valid'])
        self.assertEqual(report['producer_dropped_events'], 9)
        self.assertFalse(report['normal_footer_observed'])

    def test_collector_contiguous_prefix_over_one_mib(self):
        output = io.StringIO()
        capture = probe.Capture(output, 'host', clock=lambda: 1, limit=20000)
        for _ in range(18000):
            capture.emit('session_start', session=1)
        capture.finish(True)
        self.assertGreater(len(output.getvalue()), 1024 * 1024)
        collector, report = probe.collect(io.BytesIO(output.getvalue().encode()),
                                         Completion(0, None, False, True, False))
        self.assertTrue(report['capture_bound_drop'])
        self.assertTrue(report['capture_gap'])
        self.assertTrue(report['footer_valid'])
        self.assertFalse(report['complete_stream'])
        self.assertTrue(output.getvalue().encode().startswith(collector.header + collector.events))
        self.assertNotIn(b'"event": "end"', collector.events)

    def test_missing_start_and_truncated_record_explicit(self):
        _, report = probe.collect(io.BytesIO(b'O3DFM_SESSION_CLOCK {'),
                                  Completion(None, 'read', True, False, True))
        self.assertFalse(report['prefix_valid'])
        self.assertTrue(report['parser_truncated'])
        self.assertIn('missing-start', report['structural_errors'])


class ClockReceiptTests(unittest.TestCase):
    def test_receipt_branches_serialize_and_collect(self):
        for result, failure, expected in [(b'ok', None, 'returned'),
                                           (None, None, 'timeout'),
                                           (None, RuntimeError('synthetic'), 'raised')]:
            with self.subTest(expected=expected):
                reader, output, calls, capture = ProbeTests().host(result, failure)
                if failure:
                    with self.assertRaises(RuntimeError):
                        reader._start_session()
                else:
                    self.assertIs(reader._start_session(), result)
                capture.finish(failure is None)
                records = events(output)
                wait = next(e for e in records if e['event'] == 'identify_wait')
                self.assertEqual(wait['actual_deadline'], 22.125)
                self.assertEqual(wait['reactor_time'], 17.125)
                self.assertEqual(wait['reactor_monotonic_before_ns'], 123)
                self.assertEqual(wait['reactor_monotonic_after_ns'], 123)
                self.assertEqual(records[-3]['outcome'], expected)
                _, report = probe.collect(io.BytesIO(output.getvalue().encode()),
                                         Completion(1 if failure else 0, None, False, True, False))
                self.assertTrue(report['prefix_valid'])
                self.assertTrue(report['footer_valid'])
                self.assertEqual(json.loads(json.dumps(report)), report)
                self.assertFalse(report['complete_stream'])

    def test_raw_mono_read_order_and_nulls(self):
        calls = []
        def mono():
            calls.append('mono')
            return 100
        def raw():
            calls.append('raw')
            return 90
        output = io.StringIO()
        capture = probe.Capture(output, 'host', clock=mono, raw_clock=raw)
        self.assertEqual(calls, ['raw', 'mono', 'raw', 'mono'])
        self.assertEqual(events(output)[0], dict(event='start', role='host',
                         source_sha256=probe.HASHES['host'], monotonic_ns=100,
                         raw_before_ns=90, raw_after_ns=90))
        def broken():
            raise OSError('RAW unavailable')
        capture.raw_clock = broken
        capture.emit('session_start', session=1)
        capture.finish(True)
        _, report = probe.collect(io.BytesIO(output.getvalue().encode()),
                                 Completion(0, None, False, True, False))
        self.assertTrue(report['prefix_valid'])
        self.assertEqual(report['protocol_prefix_facts']['clock_missing_values'], 4)
        self.assertEqual(report['clock_alignment'], 'unverified')

    def test_tick_read_nested_inside_both_brackets(self):
        order = []
        output = io.StringIO()
        def read_clock(name, value):
            order.append(name)
            return value
        capture = probe.Capture(output, 'avr', clock=lambda: read_clock('mono', 100),
                                raw_clock=lambda: read_clock('raw', 90))
        class Terminal:
            def read(self):
                order.append('original')
                return b'ok'
            write = read
        def ticks():
            return read_clock('ticks', 777)
        probe.install_avr(Terminal, capture, ticks)
        order.clear()
        self.assertEqual(Terminal().read(), b'ok')
        self.assertEqual(order, ['mono', 'raw', 'ticks', 'raw', 'mono',
                                 'raw', 'mono', 'raw', 'mono', 'original'])
        pair = events(output)[1]
        self.assertEqual(pair['simulation_ticks'], 777)
        self.assertNotIn('simulation_seconds', pair)

    def test_regressions_and_legacy_missing_clocks_stay_unaligned(self):
        output = io.StringIO()
        capture = probe.Capture(output, 'host', clock=lambda: 100, raw_clock=lambda: 90)
        capture.emit('session_start', session=1)
        records = events(output)
        records[1]['raw_before_ns'] = 95
        records[1]['raw_after_ns'] = 80
        def validate(items):
            return probe.validate_prefix(io.StringIO(''.join(
                probe.PREFIX + json.dumps(item) + '\n' for item in items)))
        facts = validate(records)
        self.assertEqual(facts['clock_regressions'], 2)
        self.assertEqual(facts['interval_coverage'], 'unverified')
        for item in records:
            item.pop('raw_before_ns')
            item.pop('raw_after_ns')
        self.assertEqual(validate(records)['clock_missing_values'], 4)
        records[1]['raw_before_ns'] = True
        with self.assertRaises(ValueError):
            validate(records)

    def test_broken_reactor_observation_preserves_deadline(self):
        reader, output, _, capture = ProbeTests().host()
        # The second reactor call is observation only. Its failure must not
        # change the original deadline or the successful wait result.
        values = iter([17.125, OSError('synthetic observation')])
        def monotonic():
            value = next(values)
            if isinstance(value, Exception):
                raise value
            return value
        reader.reactor.monotonic = monotonic
        self.assertEqual(reader._start_session(), b'dictionary')
        wait = next(e for e in events(output) if e['event'] == 'identify_wait')
        self.assertEqual(wait['actual_deadline'], 22.125)
        self.assertIsNone(wait['reactor_time'])
        self.assertEqual(events(output)[-2]['outcome'], 'returned')


class AdapterTests(unittest.TestCase):
    # Original stand-ins, never external GPL source or native acceptance evidence.
    AVR = b"""import sys
class TerminalIO:
    def read(self): return b'unchanged'
    def write(self, value): return value
class Clock:
    def GetCurrentTime(self): return 77
class SystemClock:
    @staticmethod
    def Instance(): return Clock()
class pysimulavr:
    SystemClock = SystemClock
def main():
    assert sys.argv[1:] == ['--baud=250000', 'firmware.elf']
    assert TerminalIO().read() == b'unchanged'
    assert TerminalIO().write(b'a') == b'a'
"""
    HOST = b"""class SerialReader:
    def _start_session(self): pass
    def _get_identify_data(self): pass
"""

    def test_avr_executable_adapter_same_buffer_argv_and_footer(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'synthetic.py'
            source.write_bytes(self.AVR)
            output = io.StringIO()
            argv, path = sys.argv, sys.path[:]
            instrument = probe.instrument_verified
            def replace_file_after_read(data, role, namespace, sink):
                source.write_bytes(b"raise AssertionError('reopened source')")
                return instrument(data, role, namespace, sink)
            with patch.dict(probe.HASHES, avr=hashlib.sha256(self.AVR).hexdigest()):
                with patch.object(probe, 'instrument_verified', replace_file_after_read):
                    probe.run_verified('avr', source, ['--baud=250000', 'firmware.elf'], output)
                observed = events(output)
                self.assertEqual([e['event'] for e in observed], ['start', 'clock_pair', 'end'])
                self.assertTrue(observed[-1]['normal'])
            self.assertIs(sys.argv, argv)
            self.assertEqual(sys.path, path)

    def test_host_imports_instrumented_module_and_restores_on_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            source, entry = (Path(directory) / n for n in ('serialhdl.py', 'klippy.py'))
            source.write_bytes(self.HOST)
            entry.write_bytes(b"import serialhdl\nassert serialhdl.SerialReader._start_session.__name__ == 'start'\nraise RuntimeError('synthetic entry')\n")
            output = io.StringIO()
            previous = object()
            with patch.dict(sys.modules, serialhdl=previous), patch.dict(
                    probe.HASHES, host=hashlib.sha256(self.HOST).hexdigest()):
                with self.assertRaisesRegex(RuntimeError, 'synthetic entry'):
                    probe.run_verified('host', source, [], output, entry,
                                       hashlib.sha256(entry.read_bytes()).hexdigest())
                self.assertIs(sys.modules['serialhdl'], previous)
                self.assertFalse(events(output)[-1]['normal'])

    def test_entry_mismatch_precedes_source_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'serialhdl.py'
            entry = Path(directory) / 'entry.py'
            source.write_bytes(self.HOST)
            entry.write_bytes(b"raise AssertionError('must not execute')")
            output = io.StringIO()
            with patch.dict(probe.HASHES, host=hashlib.sha256(self.HOST).hexdigest()):
                with self.assertRaisesRegex(ValueError, 'host entry gate mismatch'):
                    probe.run_verified('host', source, [], output, entry, 'bad')
            self.assertEqual(output.getvalue(), '')

    def test_cli_preserves_arguments_after_separator(self):
        with patch.object(probe, 'run_verified') as run:
            probe.main(['avr', '--source', 'external.py', '--', '-b', '250000'])
        run.assert_called_once_with('avr', 'external.py', ['-b', '250000'], sys.stderr, None, None)


if __name__ == '__main__':
    unittest.main()
