# Pause driver composition checkpoint

This is source-only Connector work. The runtime does not instantiate the router, and this checkpoint does not establish product, WebRTC, simulator or printer acceptance.

The dispatcher requires a `PreparedPauseDriver`. It inspects admitted authority, checks the command and binding, verifies the signature and claims the journal before requesting one preparation. The router accepts only an opaque local binding, creates the maintained fixed Moonraker driver, and retains the attempt through actual socket closure. Its per-binding generation does not reset. The previous `PauseDriver` remains the fixed driver's send and observation interface; it is not accepted as a dispatcher driver without the required preparation and close contract. There is no default preparation path.

The command result remains bounded. Actual settlement is separate: after `close()`, await the relay's `settled` before closing the journal or restarting ownership. An unresolved operation or driver close retains its assignment and journal claim. A failed close cannot be treated as successful cleanup. Runtime integration must retain that rule and arrange owner and peer cancellation.

Focused Node tests use synthetic loopback, real signing keys and SQLite, plus driver doubles. Root still owns full checks, integration review, real HTTPS/WebRTC and isolated simulator acceptance. Automated tests must never command a physical printer.
