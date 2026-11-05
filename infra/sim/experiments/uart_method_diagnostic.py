#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Bounded observation of existing avrsim methods, never a PTY reader."""
import hashlib
import json
from pathlib import Path
import sys
import time

SOURCE_SHA256 = 'a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c'
PREFIX = 'O3DFM_UART_METHOD '
MAX_EVENTS = 4096
MAX_BYTES = 65536
MAX_CALL_BYTES = 64


def verify_source(path):
    with path.open('rb') as source:
        data = source.read(65537)
    if len(data) > 65536 or hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError('unreviewed avrsim source')
    return data


class Capture:
    def __init__(self, output, simulation_clock, monotonic=time.monotonic_ns,
                 cpu=time.process_time_ns):
        self.output, self.simulation_clock = output, simulation_clock
        self.monotonic, self.cpu = monotonic, cpu
        self.events = 0
        self.payload_bytes = 0
        self.dropped = 0
        self.failed = False
        self.empty_reads = {'bytes': 0, 'str': 0}

    def clocks(self):
        result = {}
        for name, clock in [('monotonic_ns', self.monotonic),
                            ('process_cpu_ns', self.cpu),
                            ('simulation_ticks', self.simulation_clock)]:
            try:
                value = clock()
                if type(value) is not int or value < 0:
                    raise ValueError('invalid clock')
                result[name] = value
            except Exception:
                result[name] = None
        return result

    def emit(self, event, payload=b''):
        if self.failed:
            return
        if self.events >= MAX_EVENTS or self.payload_bytes + len(payload) > MAX_BYTES:
            self.dropped += 1
            return
        self.events += 1
        self.payload_bytes += len(payload)
        try:
            self.output.write(PREFIX + json.dumps(event, sort_keys=True) + '\n')
            self.output.flush()
        except Exception:
            self.failed = True

    def finish(self, normal):
        # Reserve a separate, fixed-size footer even when the event bound was hit.
        if self.failed:
            return
        event = {'event': 'end', 'normal': normal, 'dropped': self.dropped,
                 'empty_reads': self.empty_reads, 'clocks': self.clocks()}
        try:
            self.output.write(PREFIX + json.dumps(event, sort_keys=True) + '\n')
            self.output.flush()
        except Exception:
            self.failed = True


def install_observer(terminal_class, capture):
    """Call each original method once and preserve its object or exception."""
    original_read, original_write = terminal_class.read, terminal_class.write

    def observe(kind, original, terminal, args, kwargs):
        before = capture.clocks()
        payload = b''
        try:
            argument = args[0] if args else kwargs.get('data')
            if kind == 'write' and isinstance(argument, (bytes, bytearray)):
                # The pinned decoder supplies one byte. Bound unexpected payloads.
                payload = bytes(argument[:MAX_CALL_BYTES + 1])
        except Exception:
            pass
        try:
            result = original(terminal, *args, **kwargs)
        except BaseException as error:
            try:
                capture.emit({'event': kind, 'outcome': 'raised',
                              'exception': type(error).__name__,
                              'errno': error.errno if isinstance(error, OSError) else None,
                              'before': before, 'after': capture.clocks(),
                              'argument_hex': payload.hex() if kind == 'write' else None}, payload)
            except Exception:
                capture.failed = True
            raise
        try:
            if kind == 'read' and type(result) in (bytes, str) and not result:
                key = 'bytes' if type(result) is bytes else 'str'
                capture.empty_reads[key] += 1
                # Retain first occurrence; the footer reports all empty returns.
                if capture.empty_reads[key] > 1:
                    return result
            if len(payload) > MAX_CALL_BYTES or (kind == 'read' and type(result) is bytes
                                                  and len(result) > MAX_CALL_BYTES):
                capture.dropped += 1
                return result
            event = {'event': kind, 'outcome': 'returned',
                     'before': before, 'after': capture.clocks(),
                     'return_type': type(result).__name__}
            if kind == 'read':
                payload = result if type(result) is bytes else b''
                event.update(returned_bytes=len(payload), returned_hex=payload.hex())
            else:
                event.update(argument_bytes=len(payload), argument_hex=payload.hex(),
                             syscall_count=None, delivery='unknown')
            capture.emit(event, payload)
        except Exception:
            capture.failed = True
        return result

    def read(terminal, *args, **kwargs):
        return observe('read', original_read, terminal, args, kwargs)

    def write(terminal, *args, **kwargs):
        return observe('write', original_write, terminal, args, kwargs)

    terminal_class.read, terminal_class.write = read, write


def analyze(stream):
    total = count = 0
    started = ended = False
    read_bytes = attempted = normal_writes = raised = 0
    empty_reads = None
    complete = False
    while True:
        line = stream.readline(65537)
        if not line:
            break
        total += len(line)
        if len(line) > 65536 or total > 4 * 1024 * 1024:
            raise ValueError('capture input bound exceeded')
        if not line.startswith(PREFIX):
            continue
        count += 1
        if count > MAX_EVENTS + 1:
            raise ValueError('event bound exceeded')
        item = json.loads(line[len(PREFIX):])
        if not isinstance(item, dict) or ended:
            raise ValueError('invalid event order')
        kind = item.get('event')
        if kind == 'start':
            if started or count != 1 or item.get('source_sha256') != SOURCE_SHA256:
                raise ValueError('invalid source/start')
            started = True
        elif not started:
            raise ValueError('missing start')
        elif kind == 'end':
            ended = True
            dropped = item.get('dropped')
            if type(dropped) is not int or dropped < 0 or type(item.get('normal')) is not bool:
                raise ValueError('invalid footer')
            empty_reads = item.get('empty_reads')
            if not isinstance(empty_reads, dict) or set(empty_reads) != {'bytes', 'str'} or any(
                    type(v) is not int or v < 0 for v in empty_reads.values()):
                raise ValueError('invalid empty return counters')
            complete = item['normal'] and dropped == 0
        elif kind in ('read', 'write'):
            if item.get('outcome') == 'raised':
                raised += 1
            elif item.get('outcome') == 'returned':
                field = 'returned' if kind == 'read' else 'argument'
                value, encoded = item.get(field + '_bytes'), item.get(field + '_hex')
                if type(value) is not int or value < 0 or not isinstance(encoded, str):
                    raise ValueError('invalid method bytes')
                if len(encoded) != 2 * value or len(bytes.fromhex(encoded)) != value:
                    raise ValueError('invalid hex length')
                if kind == 'read':
                    read_bytes += value
                else:
                    if item.get('syscall_count') is not None or item.get('delivery') != 'unknown':
                        raise ValueError('method cannot attest syscall delivery')
                    attempted += value
                    normal_writes += 1
            else:
                raise ValueError('invalid outcome')
        else:
            raise ValueError('unknown event')
    return {'capture': 'complete-method-capture' if complete else 'inconclusive-incomplete-capture',
            'master_read_returned_bytes': read_bytes,
            'write_argument_bytes_normal_returns': attempted,
            'write_normal_returns': normal_writes, 'propagated_exceptions': raised,
            'empty_read_returns': empty_reads,
            'write_syscall_bytes': None, 'swallowed_read_errno': None,
            'host_io_and_frame_validation': 'unobserved',
            'root_cause': 'unresolved', 'readiness': 'unobserved'}


def main(argv):
    if argv == ['analyze']:
        print(json.dumps(analyze(sys.stdin), indent=2))
        return 0
    if len(argv) < 3 or argv[0] != 'observe' or argv[2] != '--':
        raise ValueError('usage: uart_method_diagnostic.py analyze | observe AVRSIM_FILE -- ORIGINAL_ARGS')
    path = Path(argv[1]).resolve(strict=True)
    source = verify_source(path)
    sys.dont_write_bytecode = True
    namespace = {'__name__': 'o3dfm_reviewed_avrsim', '__file__': str(path)}
    exec(compile(source, str(path), 'exec'), namespace)
    capture = Capture(sys.stderr, lambda: namespace['pysimulavr'].SystemClock.Instance().GetCurrentTime())
    capture.emit({'event': 'start', 'source_sha256': SOURCE_SHA256,
                  'simulation_clock': 'SystemClock.GetCurrentTime; driver units 1e-9 seconds',
                  'clocks': capture.clocks()})
    install_observer(namespace['TerminalIO'], capture)
    sys.argv = [str(path), *argv[3:]]
    normal = False
    try:
        namespace['main']()
        normal = True
    finally:
        capture.finish(normal)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError) as error:
        print('UART_METHOD_DIAGNOSTIC_FAILED: ' + str(error), file=sys.stderr)
        sys.exit(78)
