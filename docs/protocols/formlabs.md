# Formlabs PreForm Local API

The registered read-only Connector uses an explicitly configured private,
link-local or loopback IPv4 address, or IPv6 loopback, with a configured port.
It reads `GET /devices/` using the upstream [Local API 0.9.11 reference](https://formlabs-dashboard-api-resources.s3.us-east-1.amazonaws.com/formlabs-local-api-v0.9.11.html).
Refresh validates the device list and count. HTTP failures, redirects and invalid
lists clear the snapshot. Retrieval time expires independently of printer status.

The collection selects the configured device ID and gates on connection state
and model. Each binding declares its model, `Form 4` or `Form 4L`; a host
`product_name` that differs withholds the reading. The host list may include
remote entries and other models. Form Studio 1 lacks a qualified status schema
and is unsupported. Each successful poll of a connected
supported device can publish the host-reported status text over the signed live
Farm connection. The timestamp records when the Connector queried PreForm.
Printer state and progress remain unknown: the API has no machine-readable
state or progress field, PreForm can cache data and it provides no printer
observation timestamp. A positive `estimated_print_time_remaining_ms` from the
Form 4 family shape is published as the estimated remaining time. Readings expire after five seconds
and are withdrawn on a failed poll. This status is live-only.

The synthetic fixture exercises the Form 4 family and retains extra vendor fields
for reference. The current adapter returns device ID, product name, status text,
connection state, optional connection type, IP and firmware, and the remaining
time. It does not expose tank or cartridge identity, material or estimated
dispensing.
Firmware 1.17.1 for Form 4 and Form 4L and 1.0.0 for Studio 1 refer to vendor
listings and remain unqualified on hardware.

The vendor v1 reference documents separate discovery, listing and scene endpoints.
The Connector does not call those endpoints or offer dispatch or job controls.

- [PreForm quickstart](https://developer.formlabs.com/getting-started/quickstart/)
- [Device contract, v1.0.0-alpha.1](https://developer.formlabs.com/api-reference/devices/)
- [Authentication](https://developer.formlabs.com/api-reference/authentication/)
- [Firmware releases](https://formlabs.com/support/Firmware-Release-Notes/)
- [PreForm releases](https://formlabs.com/support/PreForm-Release-Notes/)

- [Scene submission](https://developer.formlabs.com/api-reference/scenes/)
