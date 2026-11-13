// SPDX-License-Identifier: MIT
// Container-only entry point. No host ports or actuator endpoints.
import { readFileSync } from 'node:fs'
import { createSyntheticDevice } from './device.ts'
import { createSyntheticMqtt } from './mqtt.ts'

const device = createSyntheticDevice()
const selectedId = process.env.SYNTHETIC_DEVICE_ID
if (selectedId !== undefined) {
  if (!/^OPENFARM_SYNTHETIC_[A-Z0-9_]{1,160}$/.test(selectedId))
    throw new Error('Invalid synthetic identity')
  device.credentials.deviceId = selectedId
}
const mqtt = createSyntheticMqtt(
  {
    key: readFileSync('/fixture/key.pem'),
    cert: readFileSync('/fixture/cert.pem'),
  },
  { identity: device.credentials },
)
await mqtt.start({ host: '0.0.0.0', port: 9883 })
await new Promise<void>((resolve) =>
  device.server.listen(18910, '0.0.0.0', resolve),
)
console.log(
  JSON.stringify({ ready: true, deviceId: device.credentials.deviceId }),
)
const interval = setInterval(() => {
  mqtt.publishStatus()
  console.log(JSON.stringify(mqtt.snapshot()))
}, 2000)
async function stop() {
  clearInterval(interval)
  device.server.closeAllConnections()
  await Promise.all([
    mqtt.stop(),
    new Promise<void>((resolve) => device.server.close(() => resolve())),
  ])
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())

process.on('SIGUSR1', () => {
  void mqtt.stop()
})
process.on('SIGUSR2', () => {
  void mqtt.start({ host: '0.0.0.0', port: 9883 })
})
