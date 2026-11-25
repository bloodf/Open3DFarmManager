// Which Anycubic resin models have a cited, authenticated LAN session.
// Evidence and gaps: docs/fullfarmmanager/evidence/anycubic-resin.md

export type PhotonResinModelSupport = {
  model: string
  /** `cited`: a public source records a broker session on this model. */
  session: 'cited' | 'unverified'
  reason: string
  sources: readonly string[]
}

// P1 Max captures from a real printer in LAN Mode (merged 2026-11-23).
// Wire facts only: the library is GPL-3.0 and none of its code is used.
const cloudApi =
  'https://github.com/Nino6689/anycubic-cloud-api/tree/9a6707477b74f943d2513986686d92ac38ed0406'
export const photonP1MaxSources = {
  connection: 'https://github.com/Nino6689/anycubic-cloud-api/pull/2',
  reads: `${cloudApi}/tests/test_lan_photon_p1_max.py`,
  print: `${cloudApi}/tests/test_lan_photon_p1_max_print.py`,
  commands: `${cloudApi}/src/anycubic_cloud_api/lan/commands.py`,
} as const

const workshopManual =
  'https://wiki.anycubic.com/photon-p1/%E5%88%87%E7%89%87%E8%BD%AF%E4%BB%B6/Anycubic%20Photon%20Workshop-EN-V1.0.0.pdf'
const noCapture = 'No model-specific LAN session capture was found.'

function unverified(
  model: string,
  reason: string,
  ...sources: string[]
): PhotonResinModelSupport {
  return { model, session: 'unverified', reason, sources }
}

export const photonResinModels: readonly PhotonResinModelSupport[] = [
  {
    model: 'Anycubic Photon P1 Max',
    session: 'cited',
    reason:
      'A public capture records the broker session and reports; installed firmware is unrecorded.',
    sources: Object.values(photonP1MaxSources),
  },
  unverified(
    'Anycubic Photon Mono M7',
    `Outside the fleet catalog. ${noCapture}`,
    'https://store.anycubic.com/products/photon-mono-m7',
  ),
  unverified(
    'Anycubic Photon Mono M7 Pro',
    `The vendor shows a Photon Workshop LAN workflow only. ${noCapture}`,
    workshopManual,
  ),
  unverified(
    'Anycubic Photon Mono M7 Max',
    `The vendor shows a Photon Workshop LAN entry only. ${noCapture}`,
    workshopManual,
  ),
  unverified(
    'Anycubic Photon Mono 4 Ultra',
    `The vendor shows a Photon Workshop LAN transfer only. ${noCapture}`,
    workshopManual,
  ),
  unverified(
    'Anycubic Photon Mono M5s',
    `The vendor documents app operation, not a LAN API. ${noCapture}`,
    'https://wiki.anycubic.com/m5s/Photon%20Mono%20M5s-EN-V0.0.7.pdf',
  ),
  unverified(
    'Anycubic Photon M3 Max',
    'USB is the documented file input.',
    'https://wiki.anycubic.com/en/resin-3d-printer/photon-m3-max',
  ),
  unverified(
    'Anycubic Photon P1',
    'Outside the fleet catalog. Its notes (model ID 131) are not P1 Max evidence.',
    'https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md',
  ),
]

/** Static evidence only. Capabilities come from an open session's reports. */
export function photonResinModelSupport(
  model: string,
): PhotonResinModelSupport {
  return (
    photonResinModels.find((entry) => entry.model === model) ??
    unverified(model, noCapture)
  )
}
