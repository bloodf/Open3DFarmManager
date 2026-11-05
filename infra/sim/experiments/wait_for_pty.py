#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Test-only launch prerequisite. PTY availability is not MCU readiness."""
import os
import sys
import time


class PtyWaitError(Exception):
    pass


def wait_for_pty(path="/tmp/pseudoserial", timeout_seconds=30):
    if type(timeout_seconds) not in (int, float) or not 0 < timeout_seconds <= 30:
        raise PtyWaitError("invalid-timeout")
    deadline = time.monotonic() + timeout_seconds
    while True:
        if time.monotonic() >= deadline:
            raise PtyWaitError("timeout")
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY)
        except FileNotFoundError:
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))
            continue
        except OSError:
            raise PtyWaitError("unavailable") from None
        try:
            if not os.isatty(fd):
                raise PtyWaitError("not-a-pty")
        finally:
            os.close(fd)
        if time.monotonic() >= deadline:
            raise PtyWaitError("timeout")
        return


def main(argv):
    if len(argv) < 2 or argv[0] != "--" or not argv[1]:
        print("SIM_PTY_WAIT_FAILED: invalid-command", file=sys.stderr)
        return 64
    try:
        wait_for_pty()
        os.execvp(argv[1], argv[1:])
    except PtyWaitError as error:
        print(f"SIM_PTY_WAIT_FAILED: {error}", file=sys.stderr)
        return 78
    except OSError:
        print("SIM_PTY_WAIT_FAILED: launch-failed", file=sys.stderr)
        return 78
    return 78  # exec must replace this process; returning is never success.


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
