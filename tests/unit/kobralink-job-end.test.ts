import { test, expect } from 'vitest'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'

for (const [state, outcome] of [
  ['finished', 'completed'],
  ['canceled', 'cancelled'],
  ['stoped', 'cancelled'],
  ['failed', 'failed'],
] as const) {
  test(`reports ${state} as ${outcome}`, async () => {
    const now = Date.now()
    const client = createKobraLinkClient({
      origin: 'http://127.0.0.1:8080',
      allowedOrigins: ['http://127.0.0.1:8080'],
      fetch: async (url) =>
        url.includes('/api/auth/')
          ? new Response(null, {
              headers: { 'set-cookie': 'better-auth.session_token=synthetic' },
            })
          : Response.json({
              id: 'p',
              deviceId: 'd',
              name: 'Kobra',
              live: {
                connected: true,
                updatedAt: now,
                printState:
                  state === 'finished'
                    ? 'complete'
                    : state === 'failed'
                      ? 'error'
                      : 'standby',
                kobraState: state,
                filename: 'part.gcode',
                printDurationSec: 42,
                progress: 1,
              },
            }),
    })
    await client.authenticate({
      ownership: 'fresh_owned',
      mode: 'signin',
      name: 'test',
      email: 'test@example.com',
      password: 'password',
    })
    expect(
      (await client.getPrinterObservation({ id: 'p', deviceId: 'd' })).lastJob,
    ).toEqual({
      outcome,
      filename: 'part.gcode',
      printDuration: 42,
      endedAt: now,
    })
  })
}
