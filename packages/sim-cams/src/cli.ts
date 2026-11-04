import { createCameraServer } from './server.ts'

const port = Number(process.env.SIM_CAMERA_PORT ?? 8112)
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid camera port')
const camera = await createCameraServer()
camera.server.listen(port, process.env.SIM_CAMERA_HOST ?? '127.0.0.1', () => {
  console.log(`Synthetic camera listening on port ${port}`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    camera.close().catch(() => {
      process.exitCode = 1
    })
  })
}
