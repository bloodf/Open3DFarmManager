// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { browserOptions, withBrowser } from '../tests/helpers/browser.ts'

test('Node 22 and the Chrome channel can load a loopback page', async () => {
  assert.match(process.version, /^v22\./)
  assert.equal(browserOptions().channel, 'chrome')

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Docker check</title>')
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address()
    await withBrowser({}, async (browser) => {
      const page = await browser.newPage()
      const response = await page.goto(`http://127.0.0.1:${port}/`)
      assert.equal(response.status(), 200)
      assert.equal(await page.title(), 'Docker check')
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
