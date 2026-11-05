# SPDX-License-Identifier: MIT
"""Original stdlib collector for an already-open binary JSON event stream.

No launcher, deadline controller, device access or command execution. The caller
owns draining/deadlines and supplies independently observed completion facts.
"""
import io
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Completion:
    returncode: int | None
    process_error: str | None
    forced_stop: bool
    eof_observed: bool
    transport_truncated: bool

    def __post_init__(self):
        if self.returncode is not None and type(self.returncode) is not int:
            raise ValueError('invalid returncode')
        if self.process_error not in (None, 'launch', 'read', 'wait', 'timeout'):
            raise ValueError('invalid process error category')
        if any(type(v) is not bool for v in (self.forced_stop, self.eof_observed,
                                            self.transport_truncated)):
            raise ValueError('completion flags must be explicit booleans')


class Collector:
    """Retain the first header separately and a contiguous bounded event prefix.

    Continue scanning after retention fills, so duplicate starts, malformed lines
    and footer presence remain observable. Memory is bounded, total input/time is
    caller-bounded. Never feed a PTY directly: use the existing producer output.
    """
    def __init__(self, prefix, header_limit=4096, event_limit=1024 * 1024,
                 line_limit=65536, record_limit=4096):
        if not isinstance(prefix, bytes) or not prefix:
            raise ValueError('nonempty byte prefix required')
        if any(type(v) is not int or v <= 0 for v in
               (header_limit, event_limit, line_limit, record_limit)):
            raise ValueError('positive bounds required')
        self.prefix = prefix
        self.header_limit, self.event_limit = header_limit, event_limit
        self.line_limit, self.record_limit = line_limit, record_limit
        self.header = b''
        self.events = bytearray()
        self.starts = self.records = self.observed_bytes = 0
        self.dropped_records = self.dropped_bytes = 0
        self.parser_truncated = False
        self.errors = set()
        self.footer = None
        self.gap = False
        self.bound_hit = False
        self.consumed = False

    def consume(self, stream):
        if self.consumed:
            raise ValueError('collector is single-use')
        self.consumed = True
        while True:
            line = stream.readline(self.line_limit + 1)
            if not line:
                return
            self.observed_bytes += len(line)
            if len(line) > self.line_limit or not line.endswith(b'\n'):
                self.parser_truncated = True
                self.errors.add('oversized-or-unterminated-line')
                self.gap = True
                self.dropped_bytes += len(line)
                while line and not line.endswith(b'\n'):
                    line = stream.readline(self.line_limit + 1)
                    self.observed_bytes += len(line)
                    self.dropped_bytes += len(line)
                continue
            if not line.startswith(self.prefix):
                # Unrelated diagnostics are counted, never retained as events.
                continue
            self.records += 1
            try:
                item = json.loads(line[len(self.prefix):])
                if not isinstance(item, dict) or not isinstance(item.get('event'), str):
                    raise ValueError()
            except (ValueError, UnicodeError, RecursionError):
                self.errors.add('malformed-record')
                self.gap = True
                self.dropped_records += 1
                self.dropped_bytes += len(line)
                continue
            kind = item['event']
            if self.footer is not None:
                self.errors.add('record-after-footer')
            if kind == 'start':
                self.starts += 1
                if self.starts != 1 or self.records != 1:
                    self.errors.add('duplicate-or-misordered-start')
                if self.starts == 1 and len(line) <= self.header_limit:
                    self.header = line
                else:
                    self.errors.add('header-not-retained')
                continue
            if not self.header:
                self.errors.add('missing-start')
            if kind == 'end':
                self.footer = item
            if (self.gap or len(self.events) + len(line) > self.event_limit
                    or self.records > self.record_limit):
                if (len(self.events) + len(line) > self.event_limit
                        or self.records > self.record_limit):
                    self.bound_hit = True
                self.gap = True
                self.dropped_records += 1
                self.dropped_bytes += len(line)
            else:
                self.events.extend(line)

    def report(self, completion, validator):
        """Validator must structurally validate the retained protocol prefix.

        A valid observed prefix is always partial, including a zero-exit stream.
        Footer/counters and clock facts belong to the protocol validator.
        """
        if not self.consumed or not isinstance(completion, Completion):
            raise ValueError('consumed stream and explicit completion required')
        errors = sorted(self.errors | ({'missing-start'} if self.starts == 0 else set()))
        facts = None
        if not errors and self.header:
            try:
                facts = validator(io.StringIO((self.header + self.events).decode('utf-8')))
            except (ValueError, UnicodeError, RecursionError):
                errors.append('invalid-protocol-prefix')
        footer_valid = False
        if self.footer is not None and self.header:
            try:
                footer_line = self.prefix + json.dumps(self.footer).encode() + b'\n'
                validator(io.StringIO((self.header + footer_line).decode('utf-8')))
                footer_valid = True
            except (ValueError, UnicodeError, RecursionError):
                errors.append('invalid-footer')
        return {
            'contract': 'bounded-event-prefix-v1',
            'prefix_valid': facts is not None and not errors,
            'scope': 'observed-prefix-only', 'complete_stream': False,
            'completion': vars(completion),
            'bounds': {'header_bytes': self.header_limit, 'event_bytes': self.event_limit,
                       'line_bytes': self.line_limit, 'records': self.record_limit},
            'observed_bytes': self.observed_bytes, 'observed_records': self.records,
            'retained_header_bytes': len(self.header), 'retained_event_bytes': len(self.events),
            'capture_bound_drop': self.bound_hit, 'capture_gap': self.gap,
            'dropped_records': self.dropped_records,
            'dropped_bytes': self.dropped_bytes, 'parser_truncated': self.parser_truncated,
            'start_count': self.starts, 'structural_errors': errors,
            'footer_valid': footer_valid,
            'normal_footer_observed': footer_valid and self.footer.get('normal') is True,
            'producer_dropped_events': self.footer.get('dropped') if footer_valid else None,
            'footer_missing': self.footer is None,
            'protocol_prefix_facts': facts,
            'clock_alignment': 'unverified', 'delivery': 'unknown',
            'readiness': 'unobserved', 'cause': 'unresolved',
        }


def validate_uart_prefix(stream):
    """Validate UART structure with the existing analyzer plus clock schemas.

    No footer requirement here. Only Collector.report with explicit Completion
    may label this an observed prefix. The historical analyzer stays unchanged.
    """
    import uart_method_diagnostic as uart
    text = stream.read()
    clock_nulls = 0
    for line in text.splitlines():
        item = json.loads(line[len(uart.PREFIX):])
        kind = item['event']
        clocks = [item.get(key) for key in
                  (('before', 'after') if kind in ('read', 'write') else ('clocks',))]
        for clock in clocks:
            if not isinstance(clock, dict) or set(clock) != {
                    'monotonic_ns', 'process_cpu_ns', 'simulation_ticks'}:
                raise ValueError('invalid clock structure')
            for value in clock.values():
                if value is None:
                    clock_nulls += 1
                elif type(value) is not int or value < 0:
                    raise ValueError('invalid clock value')
        if kind in ('read', 'write') and item.get('outcome') == 'raised':
            if (not isinstance(item.get('exception'), str)
                    or not item['exception'] or (item.get('errno') is not None
                    and type(item['errno']) is not int)):
                raise ValueError('invalid exception structure')
        if kind == 'read' and item.get('outcome') == 'returned':
            if item.get('return_type') not in ('bytes', 'str'):
                raise ValueError('invalid read return type')
            if item['return_type'] == 'str' and item.get('returned_bytes') != 0:
                raise ValueError('string read cannot attest bytes')
    facts = uart.analyze(io.StringIO(text))
    facts.pop('capture')
    facts['clock_null_values_in_prefix'] = clock_nulls
    facts['clock_health'] = 'unverified'
    return facts
