import { describe, expect, it } from 'vitest'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
import { createControlFixture } from '../fixtures/kobralink-integration/control.ts'

async function ready() {
  const fixture = createControlFixture()
  const origin = 'http://127.0.0.1:7100'
  const client = createKobraLinkClient({
    origin,
    allowedOrigins: [origin],
    fetch: fixture.fetch,
  })
  await client.authenticate({
    ownership: 'fresh_owned',
    mode: 'signin',
    name: 'Connector',
    email: 'c@example.test',
    password: 'synthetic-password',
  })
  return { client, ...fixture }
}
describe('KobraLink print control', () => {
  it.each(['pause', 'resume', 'cancel'] as const)(
    'accepts %s through the pinned CoreController route',
    async (action) => {
      const f = await ready()
      f.state.printState = action === 'resume' ? 'paused' : 'printing'
      expect(await f.client.controlPrinter('printer-1', action)).toEqual({
        accepted: true,
        confirmed: false,
      })
      expect(f.commands).toEqual([action])
    },
  )
  it.each([
    ['pause', 'paused'],
    ['resume', 'printing'],
    ['resume', 'pausing'],
  ] as const)('rejects %s while %s', async (action, state) => {
    const f = await ready()
    f.state.printState = state
    await expect(
      f.client.controlPrinter('printer-1', action),
    ).rejects.toMatchObject({ code: 'unsupported_state' })
    expect(f.commands).toEqual([])
  })
  it.each(['paused', 'pausing'])('allows cancel while %s', async (state) => {
    const f = await ready()
    f.state.printState = state
    expect(await f.client.controlPrinter('printer-1', 'cancel')).toEqual({
      accepted: true,
      confirmed: false,
    })
    expect(f.commands).toEqual(['cancel'])
  })
  it('validates printer identifiers before transport', async () => {
    const f = await ready()
    await expect(
      f.client.controlPrinter('../other', 'pause'),
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(f.commands).toEqual([])
  })
  it.each(['standby', 'complete', 'error', 'unknown'])(
    'rejects unsupported state %s without a write',
    async (state) => {
      const f = await ready()
      f.state.printState = state
      await expect(
        f.client.controlPrinter('printer-1', 'cancel'),
      ).rejects.toMatchObject({ code: 'unsupported_state' })
      expect(f.commands).toEqual([])
    },
  )
  it.each([400, 502, 503])(
    'sanitizes bridge error %s without retry',
    async (status) => {
      const f = await ready()
      f.state.status = status
      try {
        await f.client.controlPrinter('printer-1', 'pause')
        expect.fail('must reject')
      } catch (error) {
        expect(error).toMatchObject({
          code: status === 400 ? 'invalid' : 'unavailable',
        })
        expect(String(error)).not.toContain(f.token)
        expect(JSON.stringify(error)).not.toContain(f.token)
      }
      expect(f.commands).toEqual(['pause'])
    },
  )
  it('clears an expired session and never sends a control write', async () => {
    const f = await ready()
    f.state.expired = true
    await expect(f.client.controlPrinter('printer-1', 'pause')).rejects.toThrow(
      'KobraLink: unauthorized',
    )
    f.state.expired = false
    await expect(f.client.controlPrinter('printer-1', 'pause')).rejects.toThrow(
      'KobraLink: unauthorized',
    )
    expect(f.commands).toEqual([])
  })
  it('handles expiry on the write without retry or token disclosure', async () => {
    const f = await ready()
    f.state.status = 401
    await expect(f.client.controlPrinter('printer-1', 'pause')).rejects.toThrow(
      'KobraLink: unauthorized',
    )
    await expect(f.client.controlPrinter('printer-1', 'pause')).rejects.toThrow(
      'KobraLink: unauthorized',
    )
    expect(f.commands).toEqual(['pause'])
  })
  it('rejects stale and disconnected observations', async () => {
    const f = await ready()
    f.state.updatedAt = 0
    await expect(
      f.client.controlPrinter('printer-1', 'pause'),
    ).rejects.toMatchObject({ code: 'unavailable' })
    f.state.updatedAt = Date.now()
    f.state.connected = false
    await expect(
      f.client.controlPrinter('printer-1', 'pause'),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.commands).toEqual([])
  })
  it('rejects mismatched identity and malformed acceptance', async () => {
    const f = await ready()
    f.state.id = 'other'
    await expect(
      f.client.controlPrinter('printer-1', 'pause'),
    ).rejects.toMatchObject({ code: 'identity_changed' })
    expect(f.commands).toEqual([])
    f.state.id = 'printer-1'
    f.state.malformed = true
    await expect(
      f.client.controlPrinter('printer-1', 'pause'),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})
