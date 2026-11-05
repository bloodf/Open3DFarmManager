#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Capture bounded cgroup v2 CPU counters for isolated simulator diagnostics."""
import json
from pathlib import Path
import sys
import time

CPU_STAT = Path('/sys/fs/cgroup/cpu.stat')
REQUIRED = ('usage_usec', 'nr_periods', 'nr_throttled', 'throttled_usec')


def read_counters(path=CPU_STAT):
    with path.open('r', encoding='ascii') as source:
        content = source.read(4097)
    if len(content) > 4096:
        raise ValueError('cpu.stat exceeds size limit')
    counters = {}
    for line in content.splitlines():
        key, value = line.split()
        if key in counters or not value.isascii() or not value.isdecimal():
            raise ValueError('invalid cpu.stat')
        counters[key] = int(value)
    if not all(key in counters for key in REQUIRED):
        raise ValueError('missing cgroup v2 CPU counters')
    return {key: counters[key] for key in REQUIRED}


def capture(output, read=read_counters, clock=time.monotonic, sleep=time.sleep):
    start = clock()
    for index in range(90):
        target = start + index
        delay = target - clock()
        if delay > 0:
            sleep(delay)
        before = clock()
        if before >= start + 90:
            break
        counters = read()
        after = clock()
        print(json.dumps({'before': before, 'after': after, 'counters': counters}),
              file=output, flush=True)


if __name__ == '__main__':
    try:
        capture(sys.stdout)
    except (OSError, ValueError) as error:
        print('CPU_THROTTLE_CAPTURE_FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
