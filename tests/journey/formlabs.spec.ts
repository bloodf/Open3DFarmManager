import { test } from '@playwright/test'
import { journeyEnabled } from './harness.ts'
import { startFormlabsJourneyFixture } from './formlabs-fixture.ts'

if (journeyEnabled()) {
  test('journey: Formlabs status, connection loss, recovery and unsupported controls', async () => {
    const fixture = await startFormlabsJourneyFixture()
    try {
      // Keep this acceptance gate failing until the shared harness can provision
      // a Formlabs assignment and version 7 Connector runtime. A protocol-only
      // assertion would not prove that the Farm UI received live telemetry.
      throw new Error(
        'BLOCKED: startJourneyHarness has no Formlabs vendor or custom runtime hook. Shared harness coordination with openfarm-farm is required before initial status, connection loss, recovery and unsupported controls can be exercised through the real Connector and Farm UI.',
      )
    } finally {
      await fixture.close()
    }
  })
}
