# Printer Qualification CLI (`qualify-printer.ts`)

## Overview

The Printer Qualification CLI (`scripts/qualify-printer.ts`) allows farm operators to test and qualify their 3D printers against Open3DFarmManager's supported integration backends.

The tool performs strictly read-only diagnostics:

1. **Printer Identity**: Retrieves brand, model name, firmware version, and device serial numbers where provided.
2. **Telemetry Observation**: Observes real-time telemetry frames and catalogs the specific data fields seen (e.g., job state, progress percentage, nozzle and bed temperatures, print layers, remaining times, filament slots).
3. **Camera Reachability**: Verifies whether an onboard or local camera stream (MJPEG, JPEG snapshot, or RTSPS) is accessible and operational.
4. **File Listing**: Inspects whether the printer exposes listable print job storage (e.g., Moonraker gcode root, Bambu FTPS SD storage).
5. **Catalog Promotion Assessment**: Correlates the observed hardware and proven capabilities with the internal compatibility catalog (`apps/farm/app/utils/compatibility/`), determining whether the printer model can be promoted from `simulated` or `unknown` to hardware-proven status.

## Safety and Security Guarantees

- **Strictly Read-Only**: The CLI never issues actuator commands, gcodes (e.g. `G28`, `M104`), heater targets, or state modifications (e.g. `pause`, `resume`, `cancel`).
- **Forbidden Command Rejection**: The CLI automatically detects and rejects command/actuator flags (e.g., `--command`, `--send`, `--pause`, `--resume`, `--stop`, `--cancel`, `--execute`, `--move`, `--home`, `--extrude`) with exit code 2 before any network communication begins.
- **Credential Protection**: Passwords, API tokens, and secret access codes are kept strictly in memory during the qualification run and are redacted from stdout and diagnostic outputs.
- **Local Network Scope**: Connects only to operator-supplied printer endpoints on the local network or loopback interface.

## Supported Vendors

| Vendor Argument         | Compatible Ecosystems                 | Default Port | Primary Protocol         | File Listing             | Camera Check                      |
| ----------------------- | ------------------------------------- | ------------ | ------------------------ | ------------------------ | --------------------------------- |
| `moonraker` / `klipper` | Moonraker, Klipper (Fluidd, Mainsail) | `7125`       | WebSocket JSON-RPC       | Yes (gcodes root)        | Yes (HTTP snapshot/stream)        |
| `bambu` / `bambulab`    | Bambu Lab (X1, P1, A1, H2 series)     | `8883`       | MQTTS over TLS           | Yes (Passive FTPS :990)  | Yes (TLS JPEG :6000 / RTSPS :322) |
| `creality`              | Creality K1/K2, Ender-3 V3/V4         | `9999`       | WebSocket JSON telemetry | N/A (Stock WS)           | Yes (MJPEG :8080)                 |
| `anycubic`              | Anycubic Kobra 3/4, LAN mode          | `9883`       | MQTTS over TLS           | N/A (LAN MQTT)           | N/A                               |
| `kobralink`             | Anycubic Kobra X via KobraLink        | `18910`      | HTTP REST bridge         | N/A                      | N/A                               |
| `kobra-x`               | Anycubic Kobra X, native LAN          | `9883`       | MQTTS + HTTP `/info`     | Yes (native `listLocal`) | Camera URL reachability           |

## Command-Line Usage

```bash
node scripts/qualify-printer.ts --vendor <vendor> --host <host> [credential file] [options]
```

### Positional / Named Arguments

- `--vendor`, `-v` _(required)_: One of `moonraker`, `bambu`, `creality`, `anycubic`, `kobralink`, or `kobra-x`.
- `--host`, `-h` _(required)_: IP address or hostname of the printer or controller.
- `[credential file]` _(optional)_: Path to a JSON or token file containing access credentials. Can also be supplied via `--credential-file`.

### Optional Flags

- `--port <port>`: Override default vendor communication port.
- `--serial <serial>`: Specify printer serial number (used by Bambu and Anycubic MQTT topic routing; defaults to `SYNTHETIC` if omitted).
- `--timeout <ms>`: Overall qualification timeout in milliseconds (default: `10000`).
- `--camera-port <port>`: Explicit port override for camera streaming/snapshot verification (e.g., `8080` or `6000`).
- `--ftps-port <port>`: FTPS port override for Bambu file listing (default: `990`).
- `--ca-file <path>`: Path to custom CA certificate for TLS verification.
- `--pin-sha256 <hex>`: Expected SHA-256 fingerprint for certificate pinning.
- `--webcam-origin <origin>`: Base origin for Moonraker camera paths when served from a separate frontend port.
- `--cert-file <path>` / `--key-file <path>`: Kobra X client certificate and key (PEM) override. Without them the native `kobra-x` vendor uses a local Anycubic Slicer Next installation, then the bundled Anycubic Slicer default identity.
- `--info-port <port>`: Kobra X HTTP identity port for `/info` and `/ctrl` (default `18910`).

### Native Anycubic Kobra X (`kobra-x`)

The `kobra-x` vendor talks to a Kobra X directly on the LAN, with no KobraLink bridge. It reads `GET /info` (HTTP `18910`) for identity, recovers the MQTT credentials in memory through `POST /ctrl`, and subscribes to the printer's public report topic over mutual TLS (MQTTS `9883`) with the resolved Anycubic Slicer client identity. To make an idle printer report, it publishes only read requests (`query`, `getInfo`, `listLocal`) and never a start, pause, resume, cancel, gcode, temperature, motion or upload command. The recovered credentials and the client private key stay in memory and are never written or logged. Client identity precedence: `--cert-file`/`--key-file`, then a local Anycubic Slicer Next installation, then the bundled Anycubic Slicer default (see `THIRD_PARTY.md`).

- `--help`: Display help and usage information.

## Credential File Format

Credentials may be stored in a JSON file:

### Bambu Lab (`credentials.json`)

```json
{
  "accessCode": "12345678",
  "serial": "01P00A123456789",
  "pinSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
}
```

### Moonraker (`moonraker-key.json`)

```json
{
  "apiKey": "your-moonraker-api-key"
}
```

### Anycubic LAN (`anycubic.json`)

The `anycubic` default is `9883`, matching the generic Anycubic LAN connector configuration and its TLS MQTT client. This is a transport default, not evidence that a particular printer supports it; use `--port` for a different LAN broker. Native Kobra X qualification uses the separate `kobra-x` vendor.

```json
{
  "username": "bblp",
  "password": "your-password"
}
```

### KobraLink (`kobralink.json`)

Bridge authentication requires an email and password:

```json
{
  "email": "operator@example.com",
  "password": "your-bridge-password"
}
```

Missing credentials and bridge request failures appear in `telemetry.reason` and the unreachable qualification summary. Identity stays empty until the bridge returns printer identity data.

## JSON Report Structure

When qualification completes, the tool prints a formatted JSON report to `stdout`:

```json
{
  "vendor": "moonraker",
  "host": "192.168.1.50",
  "port": 7125,
  "timestamp": "2026-11-14T19:30:00.000Z",
  "identity": {
    "vendor": "Klipper",
    "model": "Moonraker Generic",
    "firmware": "Moonraker v0.8.0"
  },
  "telemetry": {
    "observed": true,
    "fields": [
      "klippyConnected",
      "klippyState",
      "activeTool",
      "toolTemperatures"
    ],
    "sample": {
      "klippyConnected": true,
      "klippyState": "ready"
    }
  },
  "camera": {
    "reachable": true,
    "kind": "webcam",
    "url": "http://192.168.1.50:7125/webcam/?action=snapshot",
    "detail": "HTTP 200 image/jpeg"
  },
  "files": {
    "listable": true,
    "count": 12,
    "files": [
      {
        "name": "benchy.gcode",
        "size": 3451200,
        "modified": 1731600000,
        "estimatedTime": 2100
      }
    ]
  },
  "catalog": {
    "matchedCatalogId": "klipper-generic-moonraker",
    "matchedCatalogBrand": "Klipper",
    "matchedCatalogModel": "Klipper + Moonraker genérico",
    "currentCapabilities": {
      "telemetry": "simulated",
      "files": "unknown",
      "camera": "simulated",
      "materials": "unknown",
      "pause": "simulated",
      "resume": "simulated",
      "cancel": "simulated"
    },
    "provenCapabilities": {
      "telemetry": true,
      "camera": true,
      "files": true
    },
    "canPromoteToHardwareProven": true,
    "promotionNotes": [
      "Identified catalog entry: klipper-generic-moonraker (Klipper Klipper + Moonraker genérico)",
      "Telemetry observed with 4 active field(s) [klippyConnected, klippyState, activeTool, toolTemperatures]",
      "Camera verified reachable via webcam",
      "File listing verified with 12 file(s) listed"
    ]
  },
  "qualification": {
    "status": "qualified",
    "summary": "Printer successfully qualified with active telemetry (4 fields) and camera + files verified."
  }
}
```

## Recorded Reports and Catalog Promotion

Reports from real printers are stored, redacted, in [`docs/hardware-reports/`](hardware-reports/README.md). To promote a catalog capability to `hardware`:

1. Run the CLI against the printer and redact the output as that README describes.
2. Store the report in `docs/hardware-reports/`.
3. Set the capability to `hardware` on the catalog entry the report matched (`catalog.matchedCatalogId`) and list the report path in that entry's `hardwareReports`.

Only `telemetry`, `files` and `camera` can be promoted this way, and only when `catalog.provenCapabilities` is `true` for that capability. `tests/unit/catalog-hardware-evidence.test.ts` fails otherwise.

## Exit Codes

- `0`: Printer qualified or partially qualified (report output to stdout).
- `1`: Connection or qualification failure (e.g. host unreachable or communication timed out). When the run ends with status `unreachable`, the report is still printed to stdout.
- `2`: Invalid arguments, missing required options, or forbidden command flags passed.
