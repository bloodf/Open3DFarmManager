// Screenshot capture for the jobs history screen, with no UI assertions, so the
// same capture runs against the pre-polish baseline build and the polished one.
// run-jobs-docker.mjs runs it for the "before" phase; polish-jobs.spec.ts
// asserts the same capture for the "after" phase.
//
// Usage: node tests/e2e/polish-jobs-capture.ts <output-dir> [base-url]
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { captureAll } from './polish-jobs-fixtures.ts'

const [outputArg, baseURL = 'http://127.0.0.1:3000'] = process.argv.slice(2)
if (!outputArg) {
  console.error('Usage: polish-jobs-capture.ts <output-dir> [base-url]')
  process.exit(2)
}
const browser = await chromium.launch({ headless: true })
try {
  const page = await (await browser.newContext({ baseURL })).newPage()
  const written = await captureAll(page, resolve(outputArg))
  console.log(`Captured ${written.length} screenshots in ${resolve(outputArg)}`)
} finally {
  await browser.close()
}
