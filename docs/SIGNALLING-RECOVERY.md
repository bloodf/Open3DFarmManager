# Signalling reconnect timing

This preparatory component covers retry timing from E3.2.3. It opens no socket, starts no service and handles no printer commands. Authentication, proof of possession, heartbeats and resumable sessions remain unimplemented.

`SignallingBackoff.nextDelay()` returns an integer delay between one and sixty seconds. The exponential ceiling doubles after each failure and saturates at sixty seconds. Jitter selects between half the current ceiling and the ceiling, with a one-second minimum. This avoids zero-delay retry loops and spreads clients across time during a prolonged outage. Random input is validated before advancing the failure counter.

The caller must measure authenticated connection uptime with a monotonic clock. Thirty seconds of stable authenticated uptime resets the counter; a brief open/close cycle does not. This is a local reconnect tuning value, not an offline authorization lifetime. Opening a transport without successful authentication must not reset backoff.

`waitForReconnect()` accepts the Connector shutdown signal and rejects promptly on cancellation. It removes the abort listener after completion or cancellation. The future connection loop must await this delay, check cancellation and then make one signalling connection attempt. It must not wrap physical command dispatch in a retry loop.

Tests cover prolonged outages, jitter distribution boundaries, flapping connections, recovery after stable uptime, invalid inputs and immediate cancellation of a sixty-second pending wait. No test waits sixty seconds or uses a network connection. Transport integration and server-outage simulation remain acceptance gates.
