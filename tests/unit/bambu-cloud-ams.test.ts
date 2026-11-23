import { afterEach, describe, expect, it } from 'vitest'
import { startMqttBroker } from '../../packages/sim-tools/src/mocks/mqtt-broker.ts'
import { readBambuCloudAms } from '../../packages/connector/src/bambu/cloud-ams.ts'

describe('Bambu cloud AMS read', () => {
  let closeBroker: (() => Promise<void>) | undefined
  afterEach(async () => {
    await closeBroker?.()
    closeBroker = undefined
  })

  it('requests one report over TLS and returns its AMS trays', async () => {
    const broker = await startMqttBroker({
      reuseSharedTls: true,
      auth: { username: 'cloud-user', password: 'cloud-token-12345678' },
      onPublish: (message, socket) => {
        expect(message.topic).toBe('device/SYNTHETIC/request')
        expect(JSON.parse(message.payload.toString())).toEqual({
          pushing: { command: 'pushall', version: 1, push_target: 1 },
        })
        broker.control.publish('device/SYNTHETIC/report', {
          print: {
            ams: {
              tray_now: '0',
              ams: [
                { id: '0', tray: [{ id: '0', tray_type: 'PLA', remain: 37 }] },
              ],
            },
          },
        })
      },
    })
    closeBroker = broker.close
    const materials = await readBambuCloudAms({
      host: '127.0.0.1',
      port: broker.ports.mqtt,
      serial: 'SYNTHETIC',
      username: 'cloud-user',
      accessToken: 'cloud-token-12345678',
      ca: broker.control.tlsMaterial!.ca.cert,
    })
    expect(materials).toMatchObject([
      {
        slot: 'ams:0:0',
        materialType: 'PLA',
        remainingPercent: 37,
        active: true,
      },
    ])
    expect(broker.calls.all.map((message) => message.topic)).toEqual([
      'device/SYNTHETIC/request',
    ])
  })

  it('returns null on broker failure within the bounded wait', async () => {
    const result = await readBambuCloudAms({
      host: '127.0.0.1',
      port: 1,
      serial: 'SYNTHETIC',
      username: 'cloud-user',
      accessToken: 'cloud-token-12345678',
      ca: Buffer.from('test CA'),
      timeoutMs: 150,
    })
    expect(result).toBeNull()
  })
})
