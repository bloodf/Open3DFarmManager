import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import { expect, type Locator, type Page } from '@playwright/test'

async function frames(video: Locator) {
  return video.evaluate((element: HTMLVideoElement) => ({
    attached: element.srcObject !== null,
    time: element.currentTime,
    decoded: element.getVideoPlaybackQuality().totalVideoFrames,
  }))
}

/** The decoder must keep producing frames: time and decoded count advance. */
async function assertAdvancing(video: Locator) {
  const first = await frames(video)
  assert.equal(first.attached, true)
  await expect
    .poll(
      async () => {
        const current = await frames(video)
        return current.time > first.time && current.decoded > first.decoded
      },
      { timeout: 8000, intervals: [250, 500, 1000] },
    )
    .toBe(true)
  const second = await frames(video)
  assert.ok(second.time > first.time, 'Video time must advance')
  assert.ok(second.decoded > first.decoded, 'Decoded frames must increase')
  return second.decoded - first.decoded
}

/** Live video for the authorized assignment, then stop and show again (WCAG 2.2.2). */
export async function assertCameraPlaying(input: {
  page: Page
  printerKey: string
  helperPath: string
  note(value: string): Promise<void>
}) {
  const region = input.page.getByRole('region', {
    name: `Câmera da impressora ${input.printerKey}`,
    exact: true,
  })
  const video = region.locator('video')
  await expect(
    region.getByText('Câmera ao vivo.', { exact: true }),
  ).toBeVisible({ timeout: 15000 })
  const decoded = await assertAdvancing(video)
  // Positive control for the later absence check: the helper is running now.
  assert.ok(helperProcesses(input.helperPath) >= 1, 'Ingest helper running')
  await input.note(`farm-page-camera-playing-frames:${decoded}`)
  await region.getByRole('button', { name: 'Parar imagem ao vivo' }).click()
  await expect(
    region.getByText('Imagem ao vivo parada.', { exact: true }),
  ).toBeVisible()
  assert.equal((await frames(video)).attached, false)
  await region.getByRole('button', { name: 'Mostrar imagem ao vivo' }).click()
  await expect(
    region.getByText('Câmera ao vivo.', { exact: true }),
  ).toBeVisible({ timeout: 10000 })
  await assertAdvancing(video)
  await input.note('farm-page-camera-toggle-stop-show')
  return { region, video }
}

/** Decoded playback assertion for sources that own their own teardown probe. */
export async function assertCameraFramesDecoded(input: {
  page: Page
  printerKey: string
}) {
  const region = input.page.getByRole('region', {
    name: `Câmera da impressora ${input.printerKey}`,
    exact: true,
  })
  const video = region.locator('video')
  await expect(
    region.getByText('Câmera ao vivo.', { exact: true }),
  ).toBeVisible({ timeout: 15000 })
  await assertAdvancing(video)
}

/**
 * True when the first NUL-terminated entry of /proc/<pid>/cmdline is exactly
 * `path`. Reads at most path+1 bytes, so long command lines stay unbuffered.
 */
function argv0Is(pid: string, path: string) {
  const expected = Buffer.from(`${path}\0`)
  const actual = Buffer.alloc(expected.length)
  const fd = openSync(`/proc/${pid}/cmdline`, 'r')
  try {
    return (
      readSync(fd, actual, 0, actual.length, 0) === actual.length &&
      actual.equals(expected)
    )
  } finally {
    closeSync(fd)
  }
}

/**
 * Counts running ingest helpers. A real helper is its own executable. The
 * repo's journey stand-in is a launcher that `exec -a <helper>`s Node, so its
 * executable is Node and the helper path survives only as argv[0].
 */
export function helperProcesses(helperPath: string) {
  if (process.platform !== 'linux')
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
      .split('\n')
      .filter(
        (line) => line === helperPath || line.startsWith(helperPath + ' '),
      ).length

  // Pids only: never buffer other processes' potentially long command lines.
  // `comm` is no filter: Node names its main thread `MainThread`.
  const nodeExe = realpathSync(process.execPath)
  return execFileSync('ps', ['-eo', 'pid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((pid) => {
      if (!pid) return false
      try {
        const exe = readlinkSync(`/proc/${pid}/exe`)
        return (
          exe === helperPath || (exe === nodeExe && argv0Is(pid, helperPath))
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES')
          return false
        throw error
      }
    }).length
}

/**
 * After revocation: no video element in the page holds a stream (the camera
 * region may also be removed once the view sees the revoked Connector), and no
 * ingest helper is left running.
 */
export async function assertCameraDetached(input: {
  page: Page
  region: Locator
  helperPath: string
  note(value: string): Promise<void>
}) {
  await expect
    .poll(
      () =>
        input.page.evaluate(
          () =>
            [...document.querySelectorAll('video')].filter(
              (video) => video.srcObject !== null,
            ).length,
        ),
      { timeout: 10000 },
    )
    .toBe(0)
  await expect(
    input.region.getByText('Câmera ao vivo.', { exact: true }),
  ).toHaveCount(0)
  await expect
    .poll(() => helperProcesses(input.helperPath), { timeout: 10000 })
    .toBe(0)
  await input.note('farm-page-camera-detached-no-helper')
}
