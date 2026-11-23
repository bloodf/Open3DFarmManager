// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  FFMPEG_QUALIFICATION_ENV,
  qualificationEncoder,
} from '../helpers/camera-encoder.ts'
import {
  assertCameraDetached,
  assertCameraPlaying,
} from '../helpers/signalling-farm-camera.ts'
import { journeyEnabled, startJourneyHarness } from './harness.ts'

if (journeyEnabled())
  test('Kobra X passive FLV decodes over WebRTC and disconnects on revocation', async ({
    browser,
  }) => {
    test.skip(
      process.env[FFMPEG_QUALIFICATION_ENV] !== '1',
      'Requires the opt-in real FLV encoder',
    )
    // A unique executable distinguishes this journey's encoder from others.
    const directory = await mkdtemp(join(tmpdir(), 'kobra-flv-encoder-'))
    try {
      const helperPath = join(directory, 'ffmpeg')
      await copyFile(qualificationEncoder().path, helperPath)
      const sha256 = createHash('sha256')
        .update(await readFile(helperPath))
        .digest('hex')
      const journey = await startJourneyHarness({
        browser,
        kobraXCamera: { path: helperPath, sha256 },
      })
      try {
        const mock = journey.kobraX?.mock
        const camera = mock?.camera
        const url = mock?.flvUrl
        if (!mock || !camera || !url) throw new Error('Missing Kobra X camera')
        const token = new URL(url).pathname.split('/').at(-1)!
        const { ownerPage: page } = journey
        let tokenExposed = false
        const observe = (value: string | Buffer) => {
          tokenExposed ||= value.includes(token)
        }
        page.on('request', (request) =>
          observe(request.url() + (request.postData() ?? '')),
        )
        const responseChecks: Promise<void>[] = []
        page.on('response', (response) => {
          if (
            response.url().startsWith(journey.origin + '/api/') &&
            response.headers()['content-type']?.includes('application/json')
          )
            responseChecks.push(response.body().then(observe, () => {}))
        })
        page.on('websocket', (socket) => {
          socket.on('framesent', ({ payload }) => observe(payload))
          socket.on('framereceived', ({ payload }) => observe(payload))
        })

        await journey.openFarm()
        await page
          .getByRole('button', {
            name: `Inspecionar ${journey.printerKey} Imprimindo`,
          })
          .click()
        const note = async (value: string) => {
          await test
            .info()
            .attach(value, { body: value, contentType: 'text/plain' })
        }
        const { region } = await assertCameraPlaying({
          page,
          printerKey: journey.printerKey,
          helperPath,
          note,
        })
        expect(camera.capture.counts().accepted).toBeGreaterThan(0)
        expect(camera.capture.openStreams()).toBe(1)
        observe(
          await page.evaluate(() =>
            [
              document.documentElement.innerHTML,
              JSON.stringify(localStorage),
              JSON.stringify(sessionStorage),
            ].join(''),
          ),
        )
        expect(tokenExposed).toBe(false)

        await journey.revokeConnector()
        await assertCameraDetached({ page, region, helperPath, note })
        await expect.poll(() => camera.capture.openStreams()).toBe(0)
        expect(
          mock.calls.all.some(({ topic }) => topic.endsWith('/video')),
        ).toBe(false)
        await Promise.all(responseChecks)
        expect(tokenExposed).toBe(false)
      } finally {
        await journey.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
