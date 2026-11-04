# Pairing protocol contracts

These are local schemas and boundary tests for E2.4.2–E2.4.4 and E2.4.7. They do not expose endpoints, issue credentials, contact a server or approve a Connector. Device token examples in tests are synthetic strings with no valid signature.

The start request contains an Ed25519 public SPKI key, platform and bounded version string. SPKI validation checks canonical base64url and the Ed25519 DER structure; it is not a proof of possession or a full curve-point validator. The response carries a 32-byte device code, an eight-character human code, the key fingerprint, issue/expiry times and a polling interval. The pairing window is exactly fifteen minutes. Codes use the specified alphabet without ambiguous digits or vowels; the UI can normalize lowercase and one middle hyphen, while the wire format is canonical uppercase without separators.

`acceptPairingStart()` compares the returned fingerprint with the fingerprint derived locally by the Connector and rejects expired or future-issued responses. It requires a reasonably synchronized clock and performs no clock correction. Fingerprint matching does not authenticate the remote server: the future client must enforce the configured authenticated HTTPS origin.

Approval requests contain the human code, selected farm and the fingerprint the user confirmed. They cannot supply a role, private key or device token. The future server must authenticate the user, verify membership and enrollment permission, and compare the expected fingerprint with the immutable stored key before approval. A valid schema alone grants no rights.

Poll responses distinguish pending, slowdown, approved, denied and expired states. Only approved responses may carry a device token. Token validation here checks bounded serialization shape only. Cryptographic JWT verification, issuer/audience checks, expiry enforcement, key rotation and authenticated storage are separate requirements. This contract does not choose a token lifetime or settle offline revocation policy.

Required integration gates remain: cryptographically random codes with unbiased alphabet selection; hashed device-code storage; rate limits and enumeration protection; short-lived single-use proof challenges bound to the identity and session; transactional approval and one-time device-code consumption; replay rejection; expiry and denial precedence; polling throttling; authenticated farm selection; fingerprint confirmation UI; secure credential storage. A pending status never authorizes commands. The server's HTTP persistence and signalling paths must not forward printer commands.

The response parser bounds input to 12 KiB before schema validation. Transport integration must enforce request limits before buffering and define duplicate-field handling; the current parser uses standard JSON parsing and does not independently detect duplicate object fields. No endpoint or authorization state machine is supplied by this branch.
