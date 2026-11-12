import test from 'node:test'
import assert from 'node:assert/strict'
import { simulatorRtcFarmScenarios } from '../helpers/rtc-farm-acceptance-sim-scenarios.ts'

test('simulator row is absent unless both loopback origins are set', () => {
  assert.deepEqual(simulatorRtcFarmScenarios({}), {})
  assert.throws(
    () =>
      simulatorRtcFarmScenarios({
        RTC_FARM_TEST_SIM_MOONRAKER: 'http://127.0.0.1:7126',
      }),
    /Set both/,
  )
  for (const origin of [
    'https://127.0.0.1:7126',
    'http://localhost:7126',
    'http://10.0.0.5:7126',
    'http://127.0.0.1:7126/',
    'http://127.0.0.1',
  ])
    assert.throws(
      () =>
        simulatorRtcFarmScenarios({
          RTC_FARM_TEST_SIM_MOONRAKER: origin,
          RTC_FARM_TEST_SIM_SPOOLMAN: 'http://127.0.0.1:7912',
        }),
      /http:\/\/127\.0\.0\.1:<port>/,
    )
  const rows = simulatorRtcFarmScenarios({
    RTC_FARM_TEST_SIM_MOONRAKER: 'http://127.0.0.1:7126',
    RTC_FARM_TEST_SIM_SPOOLMAN: 'http://127.0.0.1:7912',
  })
  const row = rows['farm-page-simulator-inventory']
  assert.ok(row)
  assert.equal(row.env.SIGNALLING_HTTPS_SIM_MOONRAKER, 'http://127.0.0.1:7126')
  assert.equal(row.env.SIGNALLING_HTTPS_SIM_SPOOLMAN, 'http://127.0.0.1:7912')
  assert.equal(row.env.SIGNALLING_HTTPS_FARM_PAGE, 'yes')
})
