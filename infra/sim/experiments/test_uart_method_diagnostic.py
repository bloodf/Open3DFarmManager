# SPDX-License-Identifier: MIT
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch, mock_open
import uart_method_diagnostic as diagnostic


class DiagnosticTests(unittest.TestCase):
    def capture(self, **kwargs):
        stream = io.StringIO()
        capture = diagnostic.Capture(stream, lambda: 123, monotonic=lambda: 100,
                                     cpu=lambda: 50, **kwargs)
        capture.emit({'event': 'start', 'source_sha256': diagnostic.SOURCE_SHA256})
        return capture, stream

    def test_preserves_read_object_and_empty_types(self):
        values = [b'\x05\x10', b'', '', '']
        calls = []
        class Terminal:
            def read(self):
                calls.append('read')
                return values.pop(0)
            def write(self, data):
                pass
        expected = values[0]
        capture, stream = self.capture()
        diagnostic.install_observer(Terminal, capture)
        terminal = Terminal()
        self.assertIs(terminal.read(), expected)
        self.assertEqual(type(terminal.read()), bytes)
        self.assertEqual(type(terminal.read()), str)
        self.assertEqual(type(terminal.read()), str)
        capture.finish(True)
        result = diagnostic.analyze(io.StringIO(stream.getvalue()))
        self.assertEqual(calls, ['read'] * 4)
        self.assertEqual(result['master_read_returned_bytes'], 2)
        self.assertEqual(result['empty_read_returns'], {'bytes': 1, 'str': 2})
        self.assertIsNone(result['swallowed_read_errno'])
        self.assertEqual(result['root_cause'], 'unresolved')

    def test_write_none_is_not_a_syscall_count(self):
        argument = bytearray(b'\xaa')
        calls = []
        class Terminal:
            def read(self):
                return b''
            def write(self, data):
                calls.append(data)
                return None  # Synthetic method intentionally exposes no count.
        capture, stream = self.capture()
        diagnostic.install_observer(Terminal, capture)
        self.assertIsNone(Terminal().write(data=argument))
        self.assertIs(calls[0], argument)
        argument[0] = 0
        capture.finish(True)
        self.assertIn('"argument_hex": "aa"', stream.getvalue())
        result = diagnostic.analyze(io.StringIO(stream.getvalue()))
        self.assertEqual(result['write_argument_bytes_normal_returns'], 1)
        self.assertEqual(result['write_normal_returns'], 1)
        self.assertIsNone(result['write_syscall_bytes'])
        self.assertEqual(result['host_io_and_frame_validation'], 'unobserved')

    def test_propagated_exception_identity_and_errno(self):
        error = OSError(5, 'synthetic')
        class Terminal:
            def read(self):
                raise error
            def write(self, data):
                raise error
        capture, stream = self.capture()
        diagnostic.install_observer(Terminal, capture)
        for call in [Terminal().read, lambda: Terminal().write(b'x')]:
            with self.assertRaises(OSError) as caught:
                call()
            self.assertIs(caught.exception, error)
        capture.finish(False)
        self.assertIn('"errno": 5', stream.getvalue())
        result = diagnostic.analyze(io.StringIO(stream.getvalue()))
        self.assertEqual(result['propagated_exceptions'], 2)
        self.assertEqual(result['capture'], 'inconclusive-incomplete-capture')

    def test_observer_failures_preserve_return_and_exception(self):
        class BrokenOutput:
            def write(self, data):
                raise OSError('output failed')
        def broken_clock():
            raise RuntimeError('clock failed')
        capture = diagnostic.Capture(BrokenOutput(), broken_clock,
                                     monotonic=broken_clock, cpu=broken_clock)
        self.assertEqual(capture.clocks(), {'monotonic_ns': None,
                         'process_cpu_ns': None, 'simulation_ticks': None})
        class Terminal:
            def read(self):
                return b'abc'
            def write(self, data):
                raise KeyboardInterrupt()
        diagnostic.install_observer(Terminal, capture)
        self.assertEqual(Terminal().read(), b'abc')
        with self.assertRaises(KeyboardInterrupt):
            Terminal().write(b'a')
        self.assertTrue(capture.failed)

    def test_event_and_payload_bounds_mark_incomplete(self):
        for bound in ['MAX_EVENTS', 'MAX_BYTES']:
            capture, stream = self.capture()
            with patch.object(diagnostic, bound, 1):
                capture.emit({'event': 'read'}, b'ab')
            capture.finish(True)
            self.assertEqual(diagnostic.analyze(io.StringIO(stream.getvalue()))['capture'],
                             'inconclusive-incomplete-capture')
        self.assertEqual(diagnostic.analyze(io.StringIO(''))['capture'],
                         'inconclusive-incomplete-capture')
        capture, stream = self.capture()
        self.assertEqual(diagnostic.analyze(io.StringIO(stream.getvalue()))['capture'],
                         'inconclusive-incomplete-capture')

    def test_oversized_return_is_preserved_but_capture_is_incomplete(self):
        payload = b'x' * 65
        class Terminal:
            def read(self):
                return payload
            def write(self, data):
                pass
        capture, stream = self.capture()
        diagnostic.install_observer(Terminal, capture)
        self.assertIs(Terminal().read(), payload)
        capture.finish(True)
        self.assertEqual(diagnostic.analyze(io.StringIO(stream.getvalue()))['capture'],
                         'inconclusive-incomplete-capture')
        self.assertNotIn('returned_hex', stream.getvalue())

    def test_malformed_or_fabricated_delivery_rejected(self):
        capture, stream = self.capture()
        capture.emit({'event': 'write', 'outcome': 'returned', 'argument_bytes': 1,
                      'argument_hex': 'aa', 'syscall_count': 1, 'delivery': 'confirmed'})
        with self.assertRaises(ValueError):
            diagnostic.analyze(io.StringIO(stream.getvalue()))
        for text in ['x' * 65537, diagnostic.PREFIX + '[]\n',
                     diagnostic.PREFIX + json.dumps({'event': 'end'}) + '\n']:
            with self.assertRaises(ValueError):
                diagnostic.analyze(io.StringIO(text))

    def test_source_mismatch_prevents_execution(self):
        with patch.object(Path, 'open', mock_open(read_data=b'not reviewed')):
            with self.assertRaisesRegex(ValueError, 'unreviewed'):
                diagnostic.verify_source(Path('unused'))
        with patch.object(diagnostic, 'verify_source', side_effect=ValueError('unreviewed')):
            with patch('builtins.exec') as execute:
                with self.assertRaises(ValueError):
                    diagnostic.main(['observe', __file__, '--', 'ignored'])
                execute.assert_not_called()

    def test_exact_validated_bytes_execute_and_arguments_preserved(self):
        source = b'''class TerminalIO:\n def read(self): return b''\n def write(self, data): pass\ndef main():\n import sys\n assert sys.argv[1:] == ['-m', 'synthetic']\n'''
        # Synthetic source is injected after the gate; no upstream/emulator imported.
        with patch.object(diagnostic, 'verify_source', return_value=source), \
             patch.object(diagnostic.sys, 'stderr', io.StringIO()) as output, \
             patch.object(diagnostic.sys, 'argv', []):
            self.assertEqual(diagnostic.main(['observe', __file__, '--', '-m', 'synthetic']), 0)
        self.assertEqual(diagnostic.analyze(io.StringIO(output.getvalue()))['capture'],
                         'complete-method-capture')


if __name__ == '__main__':
    unittest.main()
