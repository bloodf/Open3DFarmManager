# Finite real-helper loopback gate

Source checkpoint only. Go formatting, compilation, OS policy verification and this
integration test require the separately scheduled gates. No binary distribution
approval follows from this source or the earlier offline tests.

The fixture command imports the existing maintained `internal/rtspfixture` server,
which uses the retained patched gortsplib Server/ServerStream/H264 encoder. No RTSP
parser, codec, transcoder or new dependency is introduced. All existing upstream
source pins, relative replacements and notices in `third_party/rtsp-ingest` apply.
New command-selected import/link closure and executable identity remain to verify.

## Private controller contract

The external controller owns the fixture process, its OS server profile, its
five-second lifetime, and its exact binary identity. It writes three stdin bytes:
version `01`, then the fixed nonzero port as uint16 big endian. Only TCP4
`127.0.0.1` is allowed. EOF after config cancels; any extra byte fails. The command
emits eight readiness bytes: ASCII `RTF1`, uint16 port, uint16 zero. It sends the
original synthetic HeaderAU once after successful PLAY. These bytes exercise
header-level ingest; they are **not decoded video evidence**.

For the Node integration parent the controller passes:

- fd4: the sole reader of fixture stdout;
- fd5: the sole remaining writer of fixture stdin, after writing config;
- `RTSP_LOOPBACK_GATE=1`, fixed `RTSP_FIXTURE_PORT`;
- `RTSP_HELPER_PATH`, exact `RTSP_HELPER_SHA256`;
- `RTSP_HELPER_PID_RECEIPT`: absolute, nonexistent file inside its private ledger.

Run the test in the Node runner process with `--experimental-test-isolation=none`: default process isolation does not forward arbitrary fd4/fd5 to its test worker. Confirm that pinned-runtime option in the separately approved preflight; do not silently use a worker with missing descriptors. Close controller copies of transferred pipe ends. Do not transfer stdout to two
readers. The parent checks readiness against the predetermined port, opens the
real attested helper, and exclusively creates its PID receipt before first credit.
The PID is an ownership observation, not a safe standalone kill capability; the
external runner still verifies birth/UID/group before signaling. The supervisor
exposes it through an immutable getter and still owns normal stop/reap/tempdir
cleanup. No callback grants authority.

The parent requests exactly one AU, verifies its 23 Annex B bytes, keyframe=true
and timestampUs=0, revokes its **synthetic test binding**, aborts, awaits closed,
checks the helper PID is absent, then closes fd5. After server Close the fixture
emits 28 final bytes: ASCII `RTS1`, six uint32 big-endian counters in order:
accepted, rejected, successful PLAY admissions, completed AU sends, RTP packets
accepted by stream, actual combined socket read/write bytes. Counters saturate at
65535 except actual wire bytes, bounded by the existing 2 MiB wire reservation.
The test requires 1/0/1/1, 1..8 packets, 1..2097152 wire bytes, and EOF with exactly
36 total status bytes. Stream admission is not proof of browser decoding. The
controller independently requires fixture exit zero, bounded stderr, child
settlement, one listener and no unexpected successful destinations.

The parent never starts the server or authorizes a browser/farm/Connector binding.
Authenticated identity/lease integration remains with its owner. Actual source
addresses stay in trusted private configuration, never browser messages or logs.

## Future commands and policy gates

Offline network-denied build, pinned Go1.27.1, readonly local replacements:

```
go list -mod=readonly -deps -json ./cmd/rtsp-ingest ./cmd/rtspfixture
go build -mod=readonly -p=1 -trimpath -x -o "$RUN/bin/rtsp-ingest" ./cmd/rtsp-ingest
go build -mod=readonly -p=1 -trimpath -x -o "$RUN/bin/rtspfixture" ./cmd/rtspfixture
```

Review actual closure/notices before build. Record binary hashes, file identity,
`go version -m` and build IDs; earlier `go test -c` on a no-test main produced no
helper executable and is not this gate. No commands above were executed for this
checkpoint. Existing tagged `TestNetworkPlayOrdering` still uses ephemeral Start
and a library client, so remains compile-only under the fixed-port recipe:

```
go test -mod=readonly -vet=off -tags=rtspfixture_network -c -o "$RUN/bin/fixture-order.test" ./internal/rtspfixture
```

After explicit runtime approval the external controller launches two separately
profiled roots: fixture under a fixed-port server policy, then:

```
node --test --experimental-test-isolation=none --test-concurrency=1 tools/rtsp-ingest/integration/loopback.test.ts
```

Node and its real helper inherit a client-only policy: TCP4 remote127.0.0.1:P only,
no bind/listener, UDP, IPv6, DNS or other destination. Build denies all network.
`policy-probe.mjs client P` first positively connects to the fixture, then demands
EPERM/EACCES for port P+1, alternate127.0.0.2:P, IPv6::1:P, UDP and a bind on P+1.
`build-deny P` additionally denies primaryP; `server-deny P` denies new outbound
primaryP and alternate destinations/bind. Each mode has a 4s process watchdog;
refused/unreachable/timeout is a failure, not proof of OS denial. No arbitrary
external probe address is accepted. A positive probe consumes the fixture's sole
connection: finish/reap that policy epoch before a fresh actual-helper epoch.
Unexpected allowed bind closes immediately; no handler serves it. Server reply
and client policy grammar must be verified on Darwin, never silently widened.
Linux needs an independently verified destination enforcement mechanism; seccomp
alone is insufficient. No hard RSS or Linux acceptance is claimed.

Each build command has outer60s, cache+tmp+output monitor2GiB; sequential -p1.
Runtime: outer60s owned-group watchdog, inner20s, fixture5s, helperlease3s,
helperoperation2s, parentstatus6s/test8s. Parent record/callback/credit limits are
unchanged. Status36 bytes; fixture total wire2MiB; helper stderr16KiB/retained4KiB;
private config2048; AU262144. Functional processes <=3, one fixed listener. An
external timeout cannot infer a child is gone from EPERM: record signal errors,
always bounded wait, retain live/unknown process artifacts, never signal reused or
unrelated IDs. Remove only owned binary/cache/temp outputs after settlement and
attestation; retain bounded evidence. CPU and RSS observations are not hard caps.
