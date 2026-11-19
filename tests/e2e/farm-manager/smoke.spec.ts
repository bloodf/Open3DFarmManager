import { expect, test } from './fixtures.ts'

test('sobe a farm com dois mocks Moonraker e lista as duas impressoras', async ({
  bootFarm,
}) => {
  const farm = await bootFarm({
    printers: [
      { family: 'moonraker', printerKey: 'moonraker-a' },
      { family: 'moonraker', printerKey: 'moonraker-b' },
    ],
  })
  try {
    await farm.openFarm()
    for (const { printerKey } of farm.printers)
      await expect(farm.printerCard(printerKey)).toBeVisible()
    expect(farm.blockedRequests()).toEqual([])
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})

test('a impressora única recebe telemetria ao vivo sem tráfego externo', async ({
  bootFarm,
}) => {
  const farm = await bootFarm({
    printers: [{ family: 'moonraker', printerKey: 'moonraker-solo' }],
  })
  try {
    await farm.harness.expectLiveTelemetry()
    expect(farm.printers[0]?.live).toBe(true)
    farm.assertNoOutbound()
  } catch (error) {
    console.error(farm.harness.appLog())
    throw error
  }
})
