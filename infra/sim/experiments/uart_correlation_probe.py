# SPDX-License-Identifier: MIT
"""Original local adapters, not a native launcher or an I/O interposer.

Call sites, endpoint generations and loaded-object identity need external proof.
This module never opens a PTY, imports upstream code or starts a process.
"""
import hashlib
import json
import time

from bounded_event_collector import Collector

PREFIX = b'O3DFM_UART_CORRELATION '
SOURCES = {
    'avrsim.py': 'a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c',
    'serialqueue.c': 'd519a5554233070f2560aff550899fa2402d69de08569df68b1306914823869d',
    'msgblock.c': '6a7c6db524c38408ddf5718b13626cc4c5e5f2fdf85259c2b70f5dc2c34257ef',
    'serialhdl.py': '72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad',
    'serial.c': '987c33388e07514671782b046141ce43da04abba9d484e0bfb8d1459868eb0f6',
}
IO_STAGES = ('host.write', 'master.read', 'master.write', 'host.read')
STAGES = ('d0.queue', 'd0.tx', 'd1.pin', 'd1.decode', 'frame', 'sequence', 'identify')


def verify_bytes(stream, expected, limit=128 * 1024 * 1024):
    """Hash supplied file bytes only. Does not attest a loaded native artifact."""
    if not digest(expected):
        raise ValueError('reviewed hash required')
    h = hashlib.sha256()
    size = 0
    while True:
        data = stream.read(65536)
        if not data:
            break
        size += len(data)
        if size > limit:
            raise ValueError('artifact exceeds bound')
        h.update(data)
    if h.hexdigest() != expected:
        raise ValueError('unverified artifact bytes')
    return expected


def verify_sources(streams):
    """Check all externally supplied source streams before any future use."""
    if set(streams) != set(SOURCES):
        raise ValueError('all pinned sources required')
    return {name: verify_bytes(streams[name], expected, 1024 * 1024)
            for name, expected in SOURCES.items()}


def digest(value):
    return (type(value) is str and len(value) == 64
            and all(c in '0123456789abcdef' for c in value))


def clocks(ticks=lambda: None, mono=time.monotonic_ns, cpu=time.process_time_ns):
    result = {}
    for key, clock in [('monotonic_ns', mono), ('process_cpu_ns', cpu),
                       ('simulation_ticks', ticks)]:
        try:
            value = clock()
            result[key] = value if type(value) is int and value >= 0 else None
        except Exception:
            result[key] = None
    return result


def observe_io(operation, call, fd, argument, endpoint, emit, clock=clocks):
    """Explicit call adapter, never installs hooks. Preserve result/exception.

    endpoint and clock failures remain missing observations. The native C host
    cannot use this adapter. call is invoked exactly once, without retries.
    """
    if operation not in IO_STAGES:
        raise ValueError('unknown I/O stage')

    def safe(fn):
        try:
            return fn()
        except Exception:
            return None

    before = safe(lambda: dict(clock()))
    identity_before = safe(lambda: dict(endpoint(fd)))
    writing = operation.endswith('write')
    requested = len(argument) if writing else argument
    payload = bytes(argument[:64]) if writing else b''
    result, error = None, None
    try:
        result = call(fd, argument)
        return result
    except BaseException as exc:
        error = exc
        raise
    finally:
        # No exception from diagnostics may replace the operation's outcome.
        try:
            after = safe(lambda: dict(clock()))
            identity_after = safe(lambda: dict(endpoint(fd)))
            if error is None:
                actual = result if writing else len(result)
                if not writing:
                    payload = bytes(result[:64])
                errno = None
            else:
                actual = -1 if isinstance(error, OSError) else None
                errno = error.errno if isinstance(error, OSError) else None
            emit({'event': 'io', 'stage': operation, 'requested': requested,
                  'actual': actual, 'errno': errno,
                  'exception': ('OSError' if isinstance(error, OSError) else
                                type(error).__name__) if error else None,
                  'hex': payload.hex(), 'before': before, 'after': after,
                  'endpoint_before': identity_before, 'endpoint_after': identity_after})
        except BaseException:
            pass


class Recorder:
    """Bounded single-producer sink. Caller supplies start and external stop.

    Nonblocking output and draining are caller obligations, not guaranteed here.
    No timer or automatic completion receipt. Output errors latch failed state.
    """
    def __init__(self, output, start):
        self.output = output
        self.count = self.dropped = 0
        self.failed = self.closed = False
        self._write(dict(start, event='start'))

    def _write(self, event):
        try:
            data = PREFIX + json.dumps(event, sort_keys=True).encode() + b'\n'
            if len(data) > 4096 or self.output.write(data) != len(data):
                raise ValueError('short or oversized diagnostic write')
        except Exception:
            self.failed = True

    def emit(self, event):
        if self.failed or self.closed:
            return
        if self.count >= 4094:
            self.dropped += 1
            return
        self.count += 1
        self._write(dict(event, index=self.count))

    def finish(self, normal):
        if not self.failed and not self.closed:
            self._write({'event': 'end', 'normal': normal, 'dropped': self.dropped})
        self.closed = True


def integer(value):
    return type(value) is int and value >= 0


def endpoint_valid(item):
    # Pair is an externally established relationship, not inode equality.
    return (type(item) is dict and set(item) == {
        'process', 'fd', 'generation', 'dev', 'ino', 'rdev', 'pair', 'session'}
        and all(integer(item[k]) for k in ('fd', 'dev', 'ino', 'rdev'))
        and all(type(item[k]) is str and 0 < len(item[k]) <= 128
                for k in ('process', 'generation', 'pair', 'session')))


def validate_prefix(stream, expected_binaries):
    """Validate receipts against caller-reviewed hashes, never loaded mappings.

    expected_binaries must be supplied independently, never taken from the stream.
    Native identity/coverage stay unverified even for matching claims.
    """
    if (set(expected_binaries) != {'chelper', 'pysimulavr'}
            or not all(digest(v) for v in expected_binaries.values())):
        raise ValueError('reviewed native artifact hashes required')
    start = None
    index = nulls = 0
    ended = False
    buffers = {}
    bindings = {}
    last_clock = {}
    gaps = set()
    stages = dict.fromkeys(STAGES, 0)
    for line in stream:
        if len(line) > 65536:
            raise ValueError('line bound')
        if not line.startswith(PREFIX.decode()):
            raise ValueError('unexpected prefix')
        item = json.loads(line[len(PREFIX):])
        if type(item) is not dict or ended:
            raise ValueError('invalid order')
        kind = item.get('event')
        if start is None:
            if (kind != 'start' or item.get('sources') != SOURCES
                    or item.get('binaries') != expected_binaries
                    or type(item.get('run')) is not str or not item['run']
                    or item.get('clock_domain') not in ('unverified', 'common-monotonic')):
                raise ValueError('unverified start')
            start = item
            continue
        if kind == 'end':
            if type(item.get('normal')) is not bool or not integer(item.get('dropped')):
                raise ValueError('invalid footer')
            ended = True
            continue
        index += 1
        if index > 4094 or type(item.get('index')) is not int or item['index'] != index:
            raise ValueError('event gap or bound')
        if kind == 'stage':
            # Observe upstream decisions, never implement GPL frame/CRC decoding.
            if item.get('stage') not in STAGES:
                raise ValueError('unknown stage')
            if not integer(item.get('tick')) or not integer(item.get('monotonic_ns')):
                raise ValueError('unverified stage clock')
            stages[item['stage']] += 1
            continue
        if kind != 'io' or item.get('stage') not in IO_STAGES:
            raise ValueError('invalid event')
        for key in ('before', 'after'):
            c = item.get(key)
            if type(c) is not dict or set(c) != {'monotonic_ns', 'process_cpu_ns', 'simulation_ticks'}:
                raise ValueError('missing clocks')
            for value in c.values():
                if value is not None and not integer(value):
                    raise ValueError('invalid clock')
                nulls += value is None
        for key in item['before']:
            a, b = item['before'][key], item['after'][key]
            if a is not None and b is not None and b < a:
                raise ValueError('clock regression within call')
        e = item.get('endpoint_before')
        if not endpoint_valid(e) or not endpoint_valid(item.get('endpoint_after')):
            raise ValueError('unresolved endpoint')
        req, actual, err = item.get('requested'), item.get('actual'), item.get('errno')
        if not integer(req) or type(actual) is not int or actual < -1 or actual > req:
            raise ValueError('invalid syscall counts')
        if ((actual == -1 and (not integer(err) or err == 0 or item.get('exception') != 'OSError'))
                or (actual >= 0 and (err is not None or item.get('exception') is not None))):
            raise ValueError('invalid syscall error')
        previous = last_clock.get(e['process'])
        current = item['before']['monotonic_ns']
        if previous is not None and current is not None and current < previous:
            raise ValueError('producer clock regression')
        last_clock[e['process']] = item['after']['monotonic_ns']
        raw = item.get('hex')
        if type(raw) is not str or len(raw) > 128:
            raise ValueError('payload bound')
        data = bytes.fromhex(raw)
        writing = item['stage'].endswith('write')
        expected_len = min(req if writing else max(actual, 0), 64)
        if len(data) != expected_len or raw != data.hex():
            raise ValueError('invalid payload count')
        group = (e['pair'], e['session'])
        binding = (e['process'], e['fd'])
        prior = bindings.get(binding)
        if prior is not None and prior != e:
            gaps.add((prior['pair'], prior['session']))
            gaps.add(group)
        bindings[binding] = e
        key = group + (item['stage'],)
        buffers.setdefault(key, bytearray())
        if e != item['endpoint_after'] or (actual > 64):
            gaps.add(group)
        if group not in gaps and actual > 0:
            buffers[key].extend(data[:actual])
    if start is None:
        raise ValueError('missing start')
    matches = []
    for pair, session in sorted({key[:2] for key in buffers}):
        for left, right in [('host.write', 'master.read'), ('master.write', 'host.read')]:
            a, b = (buffers.get((pair, session, stage)) for stage in (left, right))
            status = 'not-observed'
            if (pair, session) in gaps:
                status = 'incomplete'
            elif a and b:
                n = min(len(a), len(b))
                status = 'equal-observed-prefix' if a[:n] == b[:n] else 'different-observed-prefix'
            matches.append({'pair': pair, 'session': session, 'left': left,
                            'right': right, 'status': status,
                            'left_bytes': len(a or b''), 'right_bytes': len(b or b'')})
    return {'io_events_in_prefix': index - sum(stages.values()),
            'clock_null_values_in_prefix': nulls, 'stage_counts_in_prefix': stages,
            'matches': matches, 'native_identity': 'unverified',
            'call_coverage': 'unverified', 'stage_mapping': 'unverified',
            'clock_alignment': 'unverified', 'silence': 'not-established'}


def collect(stream, completion, expected_binaries, **bounds):
    collector = Collector(PREFIX, **bounds)
    collector.consume(stream)
    return collector.report(completion, lambda s: validate_prefix(s, expected_binaries))
