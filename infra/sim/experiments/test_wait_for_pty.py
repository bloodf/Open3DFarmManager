# SPDX-License-Identifier: MIT
import contextlib
import io
import os
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

import wait_for_pty as guard


class PtyWaitTests(unittest.TestCase):
    def test_missing_pty_times_out_without_launch_or_success_output(self):
        clock = [0.0]
        def advance(seconds):
            clock[0] += seconds
        output = io.StringIO()
        with patch.object(guard.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(guard.time, "sleep", side_effect=advance), \
             patch.object(guard.os, "open", side_effect=FileNotFoundError), \
             patch.object(guard.os, "execvp") as execute, \
             contextlib.redirect_stderr(output):
            self.assertEqual(guard.main(["--", "unused"]), 78)
        execute.assert_not_called()
        self.assertGreaterEqual(clock[0], 30)
        self.assertLess(clock[0], 30.2)
        self.assertIn("timeout", output.getvalue())

    def test_regular_file_is_rejected(self):
        with tempfile.NamedTemporaryFile() as file:
            with self.assertRaisesRegex(guard.PtyWaitError, "not-a-pty"):
                guard.wait_for_pty(file.name)

    def test_real_synthetic_pty_is_available_without_firmware(self):
        master, slave = os.openpty()
        try:
            guard.wait_for_pty(os.ttyname(slave))
            # No MCU speaks on this PTY: this function only checks the prerequisite.
        finally:
            os.close(master)
            os.close(slave)

    def test_deadline_rechecked_after_open_and_descriptor_closed(self):
        with patch.object(guard.time, "monotonic", side_effect=[0, 0, 30]), \
             patch.object(guard.os, "open", return_value=123), \
             patch.object(guard.os, "isatty", return_value=True), \
             patch.object(guard.os, "close") as close:
            with self.assertRaisesRegex(guard.PtyWaitError, "timeout"):
                guard.wait_for_pty()
        close.assert_called_once_with(123)

    def test_permission_error_fails_without_retry(self):
        with patch.object(guard.os, "open", side_effect=PermissionError), \
             patch.object(guard.time, "sleep") as sleep:
            with self.assertRaisesRegex(guard.PtyWaitError, "unavailable"):
                guard.wait_for_pty()
        sleep.assert_not_called()

    def test_command_arguments_are_passed_without_shell_interpretation(self):
        with patch.object(guard, "wait_for_pty"), \
             patch.object(guard.os, "execvp", side_effect=SystemExit(17)) as execute:
            with self.assertRaises(SystemExit) as result:
                guard.main(["--", "/known/program", "$(literal)", "a;b"])
        execute.assert_called_once_with("/known/program", ["/known/program", "$(literal)", "a;b"])
        self.assertEqual(result.exception.code, 17)

    def test_real_exec_preserves_the_launched_process_failure(self):
        master, slave = os.openpty()
        try:
            code = (
                "import sys,wait_for_pty as g; original=g.wait_for_pty; "
                "g.wait_for_pty=lambda: original(sys.argv[1]); "
                "g.main(['--',sys.executable,'-c','raise SystemExit(17)'])"
            )
            child = subprocess.run(
                [sys.executable, "-B", "-c", code, os.ttyname(slave)],
                cwd=os.path.dirname(__file__), capture_output=True, timeout=5,
            )
            self.assertEqual(child.returncode, 17)
            self.assertEqual(child.stdout, b"")
            self.assertEqual(child.stderr, b"")
        finally:
            os.close(master)
            os.close(slave)

    def test_exec_failure_is_nonzero_and_redacted(self):
        output = io.StringIO()
        with patch.object(guard, "wait_for_pty"), \
             patch.object(guard.os, "execvp", side_effect=OSError("sensitive")), \
             contextlib.redirect_stderr(output):
            self.assertEqual(guard.main(["--", "unused"]), 78)
        self.assertEqual(output.getvalue(), "SIM_PTY_WAIT_FAILED: launch-failed\n")

    def test_bad_arguments_do_not_wait(self):
        with patch.object(guard, "wait_for_pty") as wait, \
             contextlib.redirect_stderr(io.StringIO()):
            for args in [[], ["unused"], ["--"], ["--", ""]]:
                self.assertEqual(guard.main(args), 64)
        wait.assert_not_called()

    def test_invalid_timeouts_are_rejected(self):
        for value in [0, -1, 31, True, False, float("inf"), float("nan"), "30"]:
            with self.subTest(value=value), self.assertRaisesRegex(guard.PtyWaitError, "invalid-timeout"):
                guard.wait_for_pty(timeout_seconds=value)


if __name__ == "__main__":
    unittest.main()
