# Test-only bounded PTY prerequisite

`wait_for_pty.py` is original MIT test code. It uses Python's standard library, already present in the pinned external simulator. It is not enabled by the normal Compose file or CI and must not be installed on a physical printer or production Connector.

The launcher waits for `/tmp/pseudoserial`, opens it read-only/nonblocking without changing terminal settings or consuming data, verifies that it is a TTY, closes the probe descriptor, then replaces itself with the original command. It checks a 30-second monotonic deadline before and after probing. Missing devices time out; invalid devices and permission errors fail immediately. OS scheduling can delay when a process observes the deadline; this is not a real-time execution guarantee.

The launcher emits no success or readiness result. A PTY can exist without a responding MCU. The original Moonraker connected/ready gate and its 90-second budget remain mandatory. Launch failures return 78; malformed invocation returns 64; a launched process retains its own exit status. Arguments go directly to `execvp`, without shell interpretation. There is no launch retry.

## Local tests

Run standard-library tests without generating bytecode:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -v
```

These tests use mocks, temporary files and synthetic PTYs only. Python tests are an explicit experimental check and are not silently represented as part of the unchanged `check:all` or CI workflows.

## Isolated container experiment

Use only a reviewed digest of the external simulator. Extract its Supervisor configuration into a newly created temporary directory, preserving its external GPL licensing; do not vendor that configuration into this MIT repository. Mount this original helper and the temporary configuration read-only. In the experimental Klippy program, prepend:

```text
python3 /opt/o3dfm/wait_for_pty.py --
```

Keep the original executable and arguments after the separator. Set `autorestart=false` and `startretries=0` for Klippy in both control and intervention configurations, so failure cannot be hidden by Supervisor retries. Do not change the emulator, firmware, privileges or readiness deadline. The original image and all upstream programs remain separately licensed GPL software; this helper does not relicense them.

The temporary configuration is intentionally not a production/default override. The recorded experiment uses fresh labeled volumes, no external network or published ports, and cleans only owned resources. Missing-emulator and silent-PTY fault cases must remain unready even when the launcher behaves correctly. The diagnostic script, exact image/configuration hashes, state samples and failure logs are retained with local task evidence.
