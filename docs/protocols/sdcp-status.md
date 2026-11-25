# SDCP status and control (experimental)

The Connector supports SDCP 3.0.0 status for Saturn 4 Ultra, Saturn 4 Ultra 16K and Mars 5 Ultra candidates. Model and firmware compatibility has not been qualified on physical devices. Discovery and status behavior are based on [CBD's SDCP 3.0.0 specification](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/main/SDCP%28Smart%20Device%20Control%20Protocol%29_V3.0.0_EN.md); test data is spec-derived, not a hardware capture.

Discovery sends `M99999` over UDP and the status connection uses WebSocket on the printer's LAN. SDCP provides no authentication or encryption; only use it on a trusted network. The Connector verifies the discovered address, board ID, model and protocol version against its local binding before connecting. It periodically requests status (command 0) and withdraws stale observations. An SDCP assignment is read-only unless it is listed in `pause.control.assignmentIds`; that opt-in enables experimental pause, resume, cancel, start and file upload through the signed command boundary, as recorded with its gaps in [Elegoo evidence](../fullfarmmanager/evidence/elegoo.md). The same document covers the Centauri Carbon. No SDCP camera is exposed.

A private Connector runtime configuration can opt in using version 6. Each SDCP printer needs an existing assignment in the same farm and agent scope. The relevant sections have this shape (replace every placeholder with the local values):

```json
{
  "version": 6,
  "collection": {
    "version": 6,
    "allowedOrigins": [],
    "printers": [],
    "sdcp": {
      "printers": [
        {
          "printerKey": "resin-1",
          "host": "192.0.2.10",
          "mainboardId": "BOARD_ID",
          "model": "Saturn 4 Ultra"
        }
      ]
    }
  },
  "assignments": [
    {
      "assignment_id": "ASSIGNMENT_UUID",
      "farm_id": "FARM_UUID",
      "agent_id": "AGENT_UUID",
      "printer_key": "resin-1",
      "backend": "sdcp"
    }
  ],
  "telemetry": {
    "endpoint": "TELEMETRY_ENDPOINT",
    "audience": "TELEMETRY_AUDIENCE"
  }
}
```

This is a local configuration path, not an automatic enrollment workflow. Preserve any required existing runtime settings and protect the runtime file as a private file. The Connector rejects duplicate targets, unknown models and assignments outside its enrolled scope. An SDCP assignment outside the control opt-in has no control-capable printer handle.
