import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'

async function frames(video: Locator) {
  return video.evaluate((element: HTMLVideoElement) => ({
    attached: element.srcObject !== null,
    time: element.currentTime,
    decoded: element.getVideoPlaybackQuality().totalVideoFrames,
  }))
}

/** The decoder must keep producing frames: time and decoded count advance. */
async function assertAdvancing(video: Locator, page: Page) {
  const first = await frames(video)
  assert.equal(first.attached, true)
  await page.waitForTimeout(1500)
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
  const decoded = await assertAdvancing(video, input.page)
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
  await assertAdvancing(video, input.page)
  await input.note('farm-page-camera-toggle-stop-show')
  return { region, video }
}

function helperProcesses(helperPath: string) {
  if (process.platform !== 'linux')
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
      .split('\n')
      .filter(
        (line) => line === helperPath || line.startsWith(helperPath + ' '),
      ).length

  // Avoid buffering other processes' potentially long command lines.
  const name = basename(helperPath).slice(0, 15)
  return execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => {
      const [pid, command] = line.trim().split(/\s+/, 2)
      if (command !== name) return false
      try {
        return readlinkSync(`/proc/${pid}/exe`) === helperPath
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
