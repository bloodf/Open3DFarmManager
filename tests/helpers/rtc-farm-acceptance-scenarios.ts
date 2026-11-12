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
  })

export function selectRtcFarmScenarios(list: string | undefined) {
  const names = (list ?? Object.keys(RTC_FARM_SCENARIOS).join(','))
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
