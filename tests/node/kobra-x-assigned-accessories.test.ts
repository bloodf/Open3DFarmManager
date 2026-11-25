// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { provisionKobraXPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

function binding(assigned: boolean) {
  return provisionKobraXPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'synthetic',
    },
    {
      printerKey: 'synthetic',
      host: '127.0.0.1',
      modelId: '20030',
      deviceId: 'synthetic',
      clientCertFile: '/synthetic',
      pinSha256: 'a'.repeat(64),
      ...(assigned ? { reportIdentity: 'printer-assigned' } : {}),
    },
  )
}

for (const evidenceEnabled of [true, false]) {
  test(`printer-assigned accessories are unavailable with evidence callback ${evidenceEnabled}`, () => {
    const router = createPauseDriverRouter({
      allowedOrigins: [],
      limits: {
        maxMessageBytes: 4096,
        connectTimeoutMs: 2000,
        requestTimeoutMs: 2000,
        staleAfterMs: 2000,
        reconnectMinMs: 100,
        reconnectMaxMs: 100,
      },
      clock: { monotonicNow: () => 0 },
      observe: () => false,
      ...(evidenceEnabled
        ? {
            kobraXControlEvidence: () => ({
              fan: true,
              light: true,
              ace: true,
            }),
          }
        : {}),
    })
    const assigned = router.controls(binding(true))
    const exact = router.controls(binding(false))
    for (const action of ['set_fan', 'set_light'] as const) {
      assert.equal(assigned.includes(action), false)
      assert.equal(exact.includes(action), true)
    }
    assert.deepEqual(
      assigned,
      exact.filter((action) => action !== 'set_fan' && action !== 'set_light'),
    )
  })
}
