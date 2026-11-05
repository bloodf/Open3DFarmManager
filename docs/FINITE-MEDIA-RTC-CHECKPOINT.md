# Finite media RTC checkpoint

This test-only fixture sent original, moving encoded video over a read-only RTC track and observed decoded frames in Chromium. It does not establish RTSP ingestion or production streaming.

## Evidence

At immutable commit `7dc197b5fdf3279406189f2a31301695a830995b`, Phase A passed two tests in 1.0017 seconds. The fixture contained 30 original 128 × 96 H.264 Annex B access units, all IDR, totaling 3,972 bytes. Phase B at that same commit failed before proof exchange because its 20-character MID exceeded the 16-character limit. It sent zero proofs and access units; decode was not reached.

Commit `0dd4fb162621b49d8c283fed3ce9b202edd8f91b` changed only the MID to the 12-character ASCII value `finite-video`. Phase B then passed two tests in 6.2648425 seconds with Node 24.20.0, Bun 1.4.2 for bundling, Chromium 156.0.8078.4 and libdatachannel reporting 0.24.5. Chromium decoded 30 frames and delivered 30 `requestVideoFrameCallback` observations. The measured bright region contained 256 pixels and its center moved from 15.5 to 103.5 pixels.

Both endpoints checked their actual certificate fingerprints and completed mutual proof verification before the first access unit. On revocation the session entered read-only state, the track closed, the source detached and the next send returned false. Counts and callback observations remained stable for the following 350 milliseconds.

## Finite fixture boundary

The fixture caps admission at 60 access units, 4 MiB total, 256 KiB per unit and 10 frames per second. Its authentication deadline is eight seconds and its constructor lifetime is at most 30 seconds. It preserves the input `timestampUs` and makes one owned admission copy. It uses no NACK responder, RTCP sender-report handler or pacing handler.

These application limits do not prove native queue or process memory bounds. A false native send is terminal for this fixture and is not evidence of measured pressure. The prebuilt binary's exact source correspondence, native copy lifetime and full component inventory remain unattested. No RSS or native backpressure claim follows from this test.

The fixture does not exercise an RTSP source, SQL registry, actual WebSocket authority, production media authorization, cross-network delivery or physical hardware. Independent static review of the later source state remains in progress.
