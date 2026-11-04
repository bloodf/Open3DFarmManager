# Bounded JSON decoding

The protocol package now provides an original JSON scanner followed by native decoding. Its grammar follows [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259), while applying an intentionally stricter application profile: duplicate object names, lone Unicode surrogates and numbers that decode as nonfinite JavaScript values are rejected. This is not a claim that every such input is forbidden by the RFC.

Property names are compared after JSON escape decoding, so `a` and its Unicode-escaped representation cannot coexist in one object. Names are not Unicode-normalized; canonically equivalent but differently encoded names remain distinct. Prototype-like names remain ordinary own properties from native JSON parsing. Consumers must still validate schemas and avoid unsafe object merging or raw HTML rendering.

Defaults allow 64 KiB, 32 levels, 4096 values and 16384 UTF-16 units per decoded string, including keys. The root counts as one level and one value; keys do not separately count as values. Configurable limits have hard caps of 1 MiB, 64 levels, 100000 values and 1 MiB of UTF-16 units per string. Errors use fixed codes without echoing input. Existing IEEE-754 precision limits remain; identifier schemas must still reject unsafe integers.

The scanner bounds structure before native object construction, uses no evaluation and accepts already buffered strings. Network callers must enforce a streaming byte limit before buffering and decode UTF-8 with a fatal decoder. No streaming reader, authentication, replay protection or authorization is supplied here.

`decodeSignallingFrame()` uses this reader with an 8 KiB frame cap, then applies the existing strict signalling schema. Other branch-specific decoders are not changed by this branch; integrating the helper into pairing, Moonraker and Spoolman remains follow-up work. Existing transport code must adopt the decoder before it protects network inputs.

Tests include exact limit boundaries, escaped duplicate keys, malformed tokens, nonfinite numbers, Unicode, prototype-like keys, 500 reproducibly generated valid documents and 2000 deterministic mutations compared with native JSON. These checks are focused regression and differential tests, not a full conformance suite or independent security audit.
