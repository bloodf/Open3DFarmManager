import { simulatorRtcFarmScenarios } from './rtc-farm-acceptance-sim-scenarios.ts'

/**
 * Composable rows for scripts/test-rtc-farm-acceptance.ts. Each row is one fresh
 * `scripts/test-signalling-https.ts --run` against the shared disposable cluster
 * and sealed build, with its own roles, farm, Connector and ledger. Add pause or
 * camera rows here; the runner needs no change.
 */
export type RtcFarmScenario = {
  /** Opt-ins passed to the signalling HTTPS harness for this row only. */
  env: Readonly<Record<string, string>>
  /** Ledger lines that must appear for the row to count as passed. */
  expect: readonly string[]
  /**
   * Task-owned resources the runner starts once for every row that needs them.
   * Rows with resources are opt-in: they run only when named explicitly.
   */
  resources?: readonly 'rtsp-camera'[]
}

const farmPage = {
  SIGNALLING_HTTPS_RTC_FIXTURE: 'yes',
  SIGNALLING_HTTPS_RTC_RUNTIME: 'yes',
  SIGNALLING_HTTPS_FARM_PAGE: 'yes',
} as const
const PASS =
  'PASS real generated Nitro HTTPS/WSS admission and authenticated RTC status/closure fixture'

export const RTC_FARM_SCENARIOS: Readonly<Record<string, RtcFarmScenario>> =
  Object.freeze({
    // login → paired Connector → live status → disconnect → read-only ≤10 s →
    // recovery that carries new data
    'farm-page-disconnect': {
      env: { ...farmPage, SIGNALLING_HTTPS_RTC_CLOSURE: 'disconnect' },
      expect: [
        PASS,
        'authenticated-farm-page-disconnect-status-transition-and-readonly-degradation',
        'farm-page-readonly-after-ms:',
        'farm-page-recovered-after-ms:',
      ],
    },
    // login → paired Connector → live status → revocation → read-only ≤10 s and
    // no signalling reopen for longer than the view's reopen backoff cap
    'farm-page-revocation': {
      env: { ...farmPage, SIGNALLING_HTTPS_RTC_CLOSURE: 'revocation' },
      expect: [
        PASS,
        'authenticated-farm-page-revocation-status-transition-and-readonly-degradation',
        'farm-page-readonly-after-ms:',
        'farm-page-no-reopen-window-ms:',
      ],
    },
    // live → stale disables pause with a reason → recovery → dialog → confirm →
    // exactly one pause on the synthetic Moonraker → revocation keeps it disabled
    'farm-page-pause': {
      env: {
        ...farmPage,
        SIGNALLING_HTTPS_RTC_CLOSURE: 'disconnect',
        SIGNALLING_HTTPS_FARM_PAUSE: 'yes',
      },
      expect: [
        'PASS real generated Nitro HTTPS/WSS farm page signed pause over WebRTC to synthetic Moonraker',
        'farm-page-pause-stale-disabled-with-reason',
        'farm-page-pause-applied-after-ms:',
        'farm-page-pause-revoked-disabled-after-ms:',
        'farm-page-pause-exactly-one-applied',
        'farm-page-pause-server-frames-without-command:',
      ],
    },
    // live status → camera video plays (frames decode), stop/show toggle →
    // revocation detaches the video and leaves no ingest helper running
    'farm-page-camera': {
      env: { ...farmPage, SIGNALLING_HTTPS_RTC_CLOSURE: 'revocation' },
      resources: ['rtsp-camera'],
      expect: [
        PASS,
        'farm-page-camera-playing-frames:',
        'farm-page-camera-toggle-stop-show',
        'farm-page-camera-detached-no-helper',
      ],
    },
    // Opt-in genuine-simulator row; absent unless its origins are set.
    ...simulatorRtcFarmScenarios(),
  })

export function selectRtcFarmScenarios(list: string | undefined) {
  const defaults = Object.entries(RTC_FARM_SCENARIOS)
    .filter(([, row]) => !row.resources?.length)
    .map(([name]) => name)
  const names = (list ?? defaults.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!names.length || new Set(names).size !== names.length)
    throw new Error('Invalid RTC farm scenario list')
  return names.map((name) => {
    const scenario = RTC_FARM_SCENARIOS[name]
    if (!scenario) throw new Error('Unknown RTC farm scenario: ' + name)
    return { name, ...scenario }
  })
}
