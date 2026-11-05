#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Observe pinned simulator identification without reading its serial device."""
import hashlib
import json
from pathlib import Path
import runpy
import sys
import time

PREFIX = "O3DFM_SERIAL_DIAGNOSTIC "
MAX_EVENTS = 4096
HASHES = {
    "klippy/serialhdl.py": "72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad",
    "klippy/chelper/serialqueue.c": "d519a5554233070f2560aff550899fa2402d69de08569df68b1306914823869d",
}


def verify_source(root):
    for name, expected in HASHES.items():
        path = root / name
        with path.open("rb") as source:
            data = source.read(1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("incompatible source: " + name)


class Emitter:
    def __init__(self, output):
        self.output = output
        self.count = 0
        self.failed = False

    def __call__(self, event):
        if self.failed or self.count > MAX_EVENTS:
            return
        if self.count == MAX_EVENTS:
            event = {"event": "truncated"}
        self.count += 1
        try:
            self.output.write(PREFIX + json.dumps(event, sort_keys=True) + "\n")
            self.output.flush()
        except OSError:
            self.failed = True


def install_observer(reader_class, emit, clock=time.monotonic):
    original_start = reader_class._start_session
    original_send = reader_class.send_with_response
    original_disconnect = reader_class.disconnect
    session_number = 0
    sessions = {}

    def event(reader, kind, **fields):
        state = sessions.get(reader)
        if state is not None:
            emit({"event": kind, "session": state[0],
                  "elapsed": clock() - state[1], **fields})

    def start(reader, *args, **kwargs):
        nonlocal session_number
        session_number += 1
        sessions[reader] = (session_number, clock())
        event(reader, "start")
        try:
            result = original_start(reader, *args, **kwargs)
            event(reader, "result", success=result is True)
            return result
        finally:
            sessions.pop(reader, None)

    def send(reader, message, response, *args, **kwargs):
        result = original_send(reader, message, response, *args, **kwargs)
        if response == "identify_response" and reader in sessions:
            try:
                fields = dict(part.split("=", 1) for part in message.split()[1:])
                event(reader, "identify", requested=int(fields["offset"]),
                      offset=result["offset"], length=len(result["data"]))
            except Exception:
                event(reader, "observer_error")
        return result

    def disconnect(reader, *args, **kwargs):
        if reader in sessions and reader.serialqueue is not None:
            try:
                counters = {}
                for field in reader.stats(clock()).split():
                    key, separator, value = field.partition("=")
                    if separator and key in {
                        "bytes_write", "bytes_read", "bytes_retransmit", "bytes_invalid"
                    }:
                        counters[key] = int(value)
                event(reader, "disconnect", counters=counters)
            except Exception:
                event(reader, "observer_error")
        return original_disconnect(reader, *args, **kwargs)

    reader_class._start_session = start
    reader_class.send_with_response = send
    reader_class.disconnect = disconnect


def analyze(events):
    """Classify observed sessions; never infer raw RX counts from queue stats."""
    sessions = {}
    truncated = False
    for event in events:
        if event.get("event") == "truncated":
            truncated = True
            continue
        identity = event.get("session")
        if type(identity) is not int or identity < 1:
            raise ValueError("invalid session")
        state = sessions.setdefault(identity, {
            "session": identity, "accepted_bytes": 0, "unmatched_responses": 0,
            "terminal_response": False, "counters": {}, "finished": False,
            "success": False, "started": False, "observer_error": False,
        })
        kind = event.get("event")
        if kind == "identify":
            requested, offset, length = (
                event.get(name) for name in ("requested", "offset", "length")
            )
            if any(type(value) is not int or value < 0
                   for value in (requested, offset, length)):
                raise ValueError("invalid identification record")
            if requested == offset == state["accepted_bytes"]:
                state["accepted_bytes"] += length
                state["terminal_response"] = length == 0
            else:
                state["unmatched_responses"] += 1
        elif kind == "disconnect":
            counters = event.get("counters")
            if not isinstance(counters, dict) or any(
                type(value) is not int or value < 0 for value in counters.values()
            ):
                raise ValueError("invalid counters")
            state["counters"] = counters
        elif kind == "result":
            if type(event.get("success")) is not bool:
                raise ValueError("invalid result")
            state["finished"] = True
            state["success"] = event["success"]
        elif kind == "start":
            state["started"] = True
        elif kind == "observer_error":
            state["observer_error"] = True
        else:
            raise ValueError("unknown event")
    for state in sessions.values():
        if (truncated or not state["finished"] or not state["started"]
                or state["observer_error"]):
            classification = "inconclusive-incomplete-capture"
        elif state["success"] and state["terminal_response"]:
            classification = "identification-complete-not-readiness"
        elif state["unmatched_responses"]:
            classification = "inconclusive-unmatched-responses"
        elif state["terminal_response"]:
            classification = "inconclusive-dictionary-not-loaded"
        elif state["accepted_bytes"] and not state["terminal_response"]:
            classification = "valid-incomplete-identification"
        elif state["counters"].get("bytes_invalid", 0):
            classification = "inconclusive-invalid-or-sequence-rejected-traffic"
        else:
            classification = "inconclusive-no-identification-progress"
        state["classification"] = classification
    return {"truncated": truncated, "sessions": list(sessions.values())}


def read_events(stream):
    events = []
    total = 0
    while True:
        line = stream.readline(65537)
        if not line:
            return events
        total += len(line)
        if len(line) > 65536 or total > 16 * 1024 * 1024:
            raise ValueError("capture exceeds input bound")
        if line.startswith(PREFIX):
            item = json.loads(line[len(PREFIX):])
            if not isinstance(item, dict):
                raise ValueError("invalid event")
            events.append(item)
            if len(events) > MAX_EVENTS + 1:
                raise ValueError("too many events")


def main(argv):
    if argv == ["analyze"]:
        print(json.dumps(analyze(read_events(sys.stdin)), indent=2))
        return 0
    if len(argv) < 3 or argv[0] != "observe" or argv[2] != "--":
        raise ValueError("usage: serial_diagnostic.py analyze | observe KLIPPER_ROOT -- KLIPPY_ARGS")
    root = Path(argv[1]).resolve(strict=True)
    verify_source(root)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root / "klippy"))
    import serialhdl
    install_observer(serialhdl.SerialReader, Emitter(sys.stderr))
    sys.argv = [str(root / "klippy/klippy.py"), *argv[3:]]
    runpy.run_path(sys.argv[0], run_name="__main__")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError) as error:
        print("SIM_SERIAL_DIAGNOSTIC_FAILED: " + str(error), file=sys.stderr)
        sys.exit(78)
