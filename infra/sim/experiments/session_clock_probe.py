#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Original session probes and executable adapters. Native gates remain external."""
import argparse
import hashlib
import importlib.util
import json
import math
import sys
import time
from pathlib import Path

from bounded_event_collector import Collector

PREFIX = 'O3DFM_SESSION_CLOCK '


def raw_ns():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC_RAW)


HASHES = {
    'host': '72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad',
    'avr': 'a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c',
}


def load_verified(data, role, namespace):
    """Execute exactly the bounded validated bytes, with external GPL notices retained."""
    if role not in HASHES or len(data) > 65536 or hashlib.sha256(data).hexdigest() != HASHES[role]:
        raise ValueError('source gate mismatch')
    if namespace.get('__name__') == '__main__':
        raise ValueError('source must load without running main')
    exec(compile(data, namespace['__file__'], 'exec'), namespace)


class Capture:
    def __init__(self, output, role, clock=time.monotonic_ns, limit=4096, raw_clock=raw_ns):
        if role not in HASHES or type(limit) is not int or limit < 1:
            raise ValueError('invalid capture configuration')
        self.output, self.role, self.clock, self.limit = output, role, clock, limit
        self.raw_clock = raw_clock
        self.count = self.dropped = self.overhead_ns = 0
        self.failed = False
        self.emit('start', role=role, source_sha256=HASHES[role])

    def stamp(self, clock=None):
        try:
            value = (self.clock if clock is None else clock)()
            return value if type(value) is int and value >= 0 else None
        except Exception:
            return None

    def emit(self, event, **fields):
        if self.failed:
            return
        if event != 'end' and self.count >= self.limit:
            self.dropped += 1
            return
        raw_before = self.stamp(self.raw_clock)
        before = self.stamp()
        raw_after = self.stamp(self.raw_clock)
        try:
            self.output.write(PREFIX + json.dumps(dict(event=event, monotonic_ns=before,
                                                 raw_before_ns=raw_before, raw_after_ns=raw_after, **fields),
                                                 sort_keys=True) + '\n')
            self.output.flush()
            self.count += 1
        except Exception:
            self.failed = True
        finally:
            after = self.stamp()
            if before is not None and after is not None:
                self.overhead_ns += max(0, after - before)

    def finish(self, normal):
        self.emit('end', normal=normal, dropped=self.dropped,
                  emission_overhead_ns_before_footer=self.overhead_ns)


def install_host(reader_class, capture):
    """Wrap actual callback and wait. Never substitute a computed deadline.

    Install only on the class loaded with load_verified. Reactor registration is
    temporarily wrapped during _start_session and restored even on exception.
    Other registrations and completion objects pass through unchanged.
    """
    original_start = reader_class._start_session
    original_identify = reader_class._get_identify_data
    number = 0

    def observe_identify(callback, identity):
        def identify(*args, **kwargs):
            capture.emit('identify_start', session=identity)
            try:
                result = callback(*args, **kwargs)
            except BaseException:
                capture.emit('identify_completion', session=identity, outcome='raised')
                raise
            capture.emit('identify_completion', session=identity,
                         outcome='none' if result is None else 'returned')
            return result
        return identify

    def start(reader, *args, **kwargs):
        nonlocal number
        number += 1
        identity = number
        reactor = reader.reactor
        original_register = reactor.register_callback
        # Preserve whether the reactor originally had an instance override.
        had_override = 'register_callback' in vars(reactor)
        previous = vars(reactor).get('register_callback')

        class CompletionProxy:
            def __init__(self, completion):
                self.completion = completion

            def wait(self, *wait_args, **wait_kwargs):
                deadline = wait_args[0] if wait_args else wait_kwargs.get('waketime')
                # Sample the actual reactor domain inside a Python bracket.
                # This extra observation never replaces or recomputes wait_args.
                mono_before = capture.stamp()
                raw_before = capture.stamp(capture.raw_clock)
                try:
                    reactor_time = reactor.monotonic()
                    if type(reactor_time) not in (int, float) or not math.isfinite(reactor_time):
                        reactor_time = None
                except Exception:
                    reactor_time = None
                raw_after = capture.stamp(capture.raw_clock)
                mono_after = capture.stamp()
                capture.emit('identify_wait', session=identity, actual_deadline=deadline,
                             deadline_domain='reactor.monotonic', reactor_time=reactor_time,
                             reactor_monotonic_before_ns=mono_before,
                             reactor_monotonic_after_ns=mono_after,
                             reactor_raw_before_ns=raw_before, reactor_raw_after_ns=raw_after)
                try:
                    result = self.completion.wait(*wait_args, **wait_kwargs)
                except BaseException:
                    capture.emit('identify_wait_completion', session=identity, outcome='raised')
                    raise
                capture.emit('identify_wait_completion', session=identity,
                             outcome='timeout' if result is None else 'returned')
                return result

        def register(callback, *register_args, **register_kwargs):
            if (getattr(callback, '__self__', None) is reader
                    and getattr(callback, '__func__', None) is original_identify):
                # Bind identity here so late callbacks retain the original session.
                observed = observe_identify(callback, identity)
                return CompletionProxy(original_register(observed, *register_args, **register_kwargs))
            return original_register(callback, *register_args, **register_kwargs)

        capture.emit('session_start', session=identity)
        reactor.register_callback = register
        try:
            result = original_start(reader, *args, **kwargs)
        except BaseException:
            capture.emit('session_completion', session=identity, outcome='raised')
            raise
        else:
            capture.emit('session_completion', session=identity,
                         outcome='returned', success=result is True)
            return result
        finally:
            if had_override:
                reactor.register_callback = previous
            else:
                del reactor.register_callback

    reader_class._start_session = start


def install_avr(terminal_class, capture, ticks, period_ns=100_000_000):
    """Sample on existing calls, at most once per period. No extra PTY reader.

    Bracket each native tick read in Python monotonic time. Gaps remain visible;
    this is not a continuous clock trace or proof of a common clock domain.
    """
    last = None

    def sample():
        nonlocal last
        before = capture.stamp()
        if before is not None and last is not None and before - last < period_ns:
            return
        last = before
        raw_before = capture.stamp(capture.raw_clock)
        try:
            value = ticks()
            if type(value) is not int or value < 0:
                raise ValueError('invalid native clock')
        except Exception:
            value = None
        raw_after = capture.stamp(capture.raw_clock)
        after = capture.stamp()
        capture.emit('clock_pair', monotonic_before_ns=before,
                     simulation_ticks=value, monotonic_after_ns=after,
                     tick_raw_before_ns=raw_before, tick_raw_after_ns=raw_after)

    def wrap(original):
        def observed(*args, **kwargs):
            sample()
            return original(*args, **kwargs)
        return observed

    terminal_class.read = wrap(terminal_class.read)
    terminal_class.write = wrap(terminal_class.write)


def validate_prefix(stream):
    role = None
    counts = {}
    previous = {}
    clock_missing = clock_regressions = 0
    ended = False
    allowed = {'session_start', 'session_completion', 'identify_start',
               'identify_completion', 'identify_wait', 'identify_wait_completion', 'clock_pair'}
    for line in stream:
        item = json.loads(line[len(PREFIX):])
        kind = item.get('event')
        # Older retained streams lack RAW fields and remain explicitly unaligned.
        for key in ('monotonic_ns', 'raw_before_ns', 'raw_after_ns'):
            value = item.get(key)
            if value is None:
                clock_missing += 1
            elif type(value) is not int or value < 0:
                raise ValueError('invalid clock')
            else:
                if key in previous and value < previous[key]:
                    clock_regressions += 1
                previous[key] = value
        for left, right in (('raw_before_ns', 'raw_after_ns'),
                            ('tick_raw_before_ns', 'tick_raw_after_ns'),
                            ('reactor_raw_before_ns', 'reactor_raw_after_ns'),
                            ('reactor_monotonic_before_ns', 'reactor_monotonic_after_ns')):
            a, b = item.get(left), item.get(right)
            for value in (a, b):
                if value is not None and (type(value) is not int or value < 0):
                    raise ValueError('invalid RAW bracket')
            if a is not None and b is not None and a > b:
                clock_regressions += 1
        if ended or (item.get('monotonic_ns') is not None and
                     (type(item['monotonic_ns']) is not int or item['monotonic_ns'] < 0)):
            raise ValueError('invalid event')
        if role is None:
            role = item.get('role')
            if kind != 'start' or role not in HASHES or item.get('source_sha256') != HASHES[role]:
                raise ValueError('invalid start')
        elif kind == 'end':
            if type(item.get('normal')) is not bool or type(item.get('dropped')) is not int or item['dropped'] < 0:
                raise ValueError('invalid footer')
            ended = True
        elif kind not in allowed:
            raise ValueError('unknown event')
        elif kind == 'clock_pair':
            before, after, ticks = (item.get(k) for k in
                                    ('monotonic_before_ns', 'monotonic_after_ns', 'simulation_ticks'))
            if ((before is not None and (type(before) is not int or before < 0))
                    or (after is not None and (type(after) is not int or after < 0))
                    or (before is not None and after is not None and before > after)
                    or (ticks is not None and (type(ticks) is not int or ticks < 0))):
                raise ValueError('invalid pair')
        elif type(item.get('session')) is not int or item['session'] < 1:
            raise ValueError('missing session')
        elif kind == 'identify_wait':
            deadline = item.get('actual_deadline')
            if (type(deadline) not in (int, float) or not math.isfinite(deadline)
                    or deadline < 0 or item.get('deadline_domain') != 'reactor.monotonic'):
                raise ValueError('invalid actual deadline')
            observed = item.get('reactor_time')
            if observed is not None and (type(observed) not in (int, float)
                                         or not math.isfinite(observed)):
                raise ValueError('invalid reactor sample')
        elif kind in ('identify_completion', 'identify_wait_completion', 'session_completion'):
            if item.get('outcome') not in ('raised', 'none', 'timeout', 'returned'):
                raise ValueError('invalid completion')
        counts[kind] = counts.get(kind, 0) + 1
    return {'role': role, 'counts_in_prefix': counts,
            'clock_missing_values': clock_missing, 'clock_regressions': clock_regressions,
            'interval_coverage': 'unverified'}


def collect(stream, completion):
    collector = Collector(PREFIX.encode())
    collector.consume(stream)
    return collector, collector.report(completion, validate_prefix)


def instrument_verified(data, role, namespace, output):
    """Production entry point. Gate before executing bytes or installing wrappers."""
    load_verified(data, role, namespace)
    capture = Capture(output, role)
    if role == 'host':
        install_host(namespace['SerialReader'], capture)
    else:
        install_avr(namespace['TerminalIO'], capture,
                    lambda: namespace['pysimulavr'].SystemClock.Instance().GetCurrentTime())
    return capture


def run_verified(role, source, arguments, output, host_entry=None, host_entry_sha256=None):
    """Run pinned external bytes with original argv and imports, then emit footer.

    The private launcher must attest loaded identities before calling this.
    Unknown tick units do not block observation; report raw counts only.
    This adapter does not establish those gates or authorize a native run.
    Host serialhdl is installed before klippy's imports. AVR main is called only
    after its exact source bytes have loaded and its wrappers are installed.
    """
    if role not in HASHES:
        raise ValueError('source gate mismatch')
    source = Path(source).resolve()
    with source.open('rb') as stream:
        data = stream.read(65537)
    if len(data) > 65536 or hashlib.sha256(data).hexdigest() != HASHES[role]:
        raise ValueError('source gate mismatch')
    entry_data = None
    if role == 'host':
        if host_entry is None or host_entry_sha256 is None:
            raise ValueError('private pinned host entry required')
        host_entry = Path(host_entry).resolve()
        with host_entry.open('rb') as stream:
            entry_data = stream.read(1024 * 1024 + 1)
        if len(entry_data) > 1024 * 1024 or hashlib.sha256(entry_data).hexdigest() != host_entry_sha256:
            raise ValueError('host entry gate mismatch')
    old_path, old_argv = sys.path[:], sys.argv
    previous = sys.modules.get('serialhdl')
    capture = None
    normal = False
    try:
        sys.path.insert(0, str(source.parent))
        sys.argv = [str(host_entry if role == 'host' else source), *arguments]
        name = 'serialhdl' if role == 'host' else '_o3dfm_verified_avrsim'
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader=None))
        module.__file__ = str(source)
        capture = instrument_verified(data, role, vars(module), output)
        if role == 'host':
            sys.modules['serialhdl'] = module
            # Compile the already-verified buffer, never reopen the entry file.
            namespace = {'__file__': str(host_entry), '__name__': '__main__', '__package__': None}
            exec(compile(entry_data, str(host_entry), 'exec'), namespace)
        else:
            module.main()
        normal = True
    except SystemExit as exc:
        normal = exc.code in (None, 0)
        raise
    finally:
        if capture is not None:
            capture.finish(normal)
        sys.path[:] = old_path
        sys.argv = old_argv
        if role == 'host':
            if previous is None:
                sys.modules.pop('serialhdl', None)
            else:
                sys.modules['serialhdl'] = previous


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    separator = argv.index('--') if '--' in argv else len(argv)
    arguments = argv[separator + 1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=('host', 'avr'))
    parser.add_argument('--source', required=True)
    parser.add_argument('--host-entry')
    parser.add_argument('--host-entry-sha256')
    options = parser.parse_args(argv[:separator])
    run_verified(options.role, options.source, arguments, sys.stderr,
                 options.host_entry, options.host_entry_sha256)


if __name__ == '__main__':
    main()
