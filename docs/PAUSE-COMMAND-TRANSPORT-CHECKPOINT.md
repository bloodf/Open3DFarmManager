# Bounded pause command transport channel

Status: `em revisão`
Slice: transport only, no authority.
Base source: `d37416c5754a4a798b715f471c569d18c5436d0c`
Branch: `t3/pause-command-transport`

## What this slice is

The pause control session could carry the admission metadata and nothing else.
`control.command` and `control.result` already existed in the channel schema,
but no reachable path delivered them. This slice adds that path and keeps it
bounded, directional and disabled by default.

Nothing in `farm-protocol` changed. `control.command` carries a canonical
command v2 wire and `control.result` carries `command_id` plus one of the four
existing outcomes (`rejected`, `not-sent`, `applied`, `outcome-unknown`).

| File                                                      | Change                                                                                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connector/src/webrtc/pause-control-session.ts`  | `PauseDataFrame`, `PauseDataMessage`, `PauseCommandMessage`, `PauseResultMessage`, `PauseCommandOutcome`; optional `onData` handler; `sendCommand` (browser) and `sendResult` (connector) |
| `packages/connector/src/webrtc/pause-control-peer.ts`     | Connector peer `sendResult` and `onData` option                                                                                                                                           |
| `apps/farm/app/utils/webrtc/pause-control-peer.ts`        | browser peer `sendCommand` and `onData` option                                                                                                                                            |
| `packages/connector/src/cloud/pause-signalling-client.ts` | Connector client `sendResult`, `onData` option, direction lock                                                                                                                            |
| `apps/farm/app/utils/webrtc/pause-signalling-client.ts`   | browser client `sendCommand`, `onData` option, direction lock                                                                                                                             |

No protocol schema, index, read-only peer, capability verifier, dispatcher,
driver, runtime, CLI, SQL or UI file was touched.

## Rules the transport enforces

**Direction.** The browser sends `control.command` only. The Connector sends
`control.result` only. A wrong-direction frame closes the peer; a
wrong-direction send attempt closes the peer with `invalid-send`, mirroring the
existing `sendPhase` behavior.

**Ordering.** A command may only travel after the mutual control proofs and
after the existing admission sequence: the browser already sent
`control.capability` and `control.admission-proof`, and the Connector already
received both. A result may only travel after its command.

**One command, one result.** Per control peer there is at most one command and
at most one matching result. The reservation happens before the handler
callback and before the send, so a reentrant call cannot open a second one.

**Correlation.** The session decodes the command wire itself and keeps
`cmd_id`. The Connector may only answer with that `command_id`; the browser
only accepts a result carrying it. A mismatch closes the peer. No outcome is
ever invented.

**Disabled by default.** The channel exists only when a trusted composition
supplies `onData`. Without it, a received command or result closes the peer
exactly like any other unexpected frame. `diagnostics().commandsEnabled`
remains `false` on the session, on both peers and on both signalling clients.

**Retained limits.** The data frames use the original shared frame sequence
counter, the original `BoundedReceive` queue with UTF-8 byte accounting, the
original 17408-byte outer and 8192-byte inner caps, the original eight-second
authentication deadline and the original thirty-second lifetime deadline.
Command traffic does not renew any deadline.

### Fail-closed matrix

| Condition                             | Outcome                                    |
| ------------------------------------- | ------------------------------------------ |
| wrong direction, send or receive      | peer closes                                |
| duplicate command or duplicate result | peer closes                                |
| command before the admission sequence | peer closes                                |
| result before its command             | peer closes                                |
| mismatched `command_id`               | peer closes                                |
| malformed command wire                | send refused, peer closes, no result frame |
| handler throws or returns a promise   | peer closes with `data-callback`           |
| session expired or closed             | send refused                               |

## Authority boundary

Transport delivery is never authority. The handler receives the command wire
and nothing else: no capability, no handle, no binding. The future relay must
carry the same dispatcher handle through `beginAdmission`, `admit` and
`dispatch`, and must use the dispatcher's own journal and driver. This slice
executes no driver, issues no capability and leaves `commandsEnabled` false.

## Evidence

`tests/node/pause-command-transport.test.ts` is new and covers, with genuine
P-256 device keys, a genuine Ed25519 issuer, a genuine Connector identity and
real signed control proofs:

- one genuine command travelling browser to Connector and the matching result
  returning, including the shared frame sequence on both directions;
- the channel staying disabled without a trusted handler;
- the direction lock on both sides, for sending and for receiving;
- one command and one result per control peer;
- a command refused before the admission sequence;
- a result refused before its command;
- a mismatched `command_id` refused in both directions;
- a throwing handler and a promise-returning handler, both failing closed with
  no result frame;
- reentrant delivery unable to open a second result;
- a malformed command wire refused and never answered;
- the lifetime not being extended by command traffic;
- the browser peer and both signalling wrappers exposing a directional API that
  stays inert by default.

No network, native, browser, PostgreSQL, Docker or hardware execution was
performed. The browser peer test uses a local stand-in for the WebRTC API and
the Connector signalling client was constructed without opening a socket.

## Not proven here

This slice proves the transport path only. It does not prove command
authority, dispatch, the durable journal, the fixed Moonraker driver, a
genuine printer pause or the simulator gate. The authority composition is the
next slice.
