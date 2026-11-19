// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const docPath = join(root, 'docs/compatibility/kobra-x-lan.md')
const doc = readFileSync(docPath, 'utf8')

const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-')

const headings = [...doc.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1])
const headingSlugs = new Set(headings.map(slug))

const sectionBodies = () => {
  const parts = doc.split(new RegExp(`^## `, 'm')).slice(1)
  return parts.map((part) => {
    const [title, ...rest] = part.split('\n')
    return { title: title.trim(), body: rest.join('\n') }
  })
}

test('spec document exists with MIT clean-room statement and status legend', () => {
  assert.match(
    doc,
    /^# Anycubic Kobra X LAN protocol \(clean-room specification\)/m,
  )
  assert.match(doc, /License of this document: MIT/)
  assert.match(doc, /## Purpose and clean-room rules/)
  assert.match(doc, /## Status and source legend/)
  for (const tag of ['`observed`', '`reported`', '`not verified`']) {
    assert.ok(doc.includes(tag), `status tag ${tag} missing from legend`)
  }
})

test('covers every transport the adapter needs', () => {
  for (const needle of [
    '1900',
    '239.255.255.250',
    '18910',
    '9883',
    'MQTT 3.1.1',
    'mutual TLS',
    'HTTP-FLV',
    '18088',
  ]) {
    assert.ok(doc.includes(needle), `transport fact ${needle} missing`)
  }
})

test('covers SSDP discovery, the empty-datagram reply and GET /info fields', () => {
  assert.match(doc, /exactly one empty UDP datagram \(0 bytes\)/)
  for (const field of [
    '`cn`',
    '`ctrlInfoUrl`',
    '`ctrlType`',
    '`deviceName`',
    '`deviceType`',
    '`env`',
    '`ip`',
    '`modelId`',
    '`modelName`',
    '`token`',
    '`usn`',
    '`zone`',
  ]) {
    assert.ok(doc.includes(field), `GET /info field ${field} missing`)
  }
  assert.match(doc, /Adapter must not follow|must not follow it/)
})

test('covers HTTP credential recovery, AES-128-CBC and gcode upload', () => {
  assert.match(doc, /POST \/ctrl/)
  assert.match(doc, /AES-128-CBC/)
  assert.match(doc, /POST \/gcode_upload/)
  for (const field of ['`username`', '`password`', '`deviceId`', '`modeId`']) {
    assert.ok(doc.includes(field), `credential blob field ${field} missing`)
  }
})

test('covers the MQTT client-certificate requirement and self-signed server certificate', () => {
  assert.match(doc, /client certificate/)
  assert.match(doc, /CN=AnycubicSlicer/)
  assert.match(doc, /self-signed/)
  assert.match(doc, /DEFAULT:@SECLEVEL=0/)
})

test('covers topic layout, message types, ack and report semantics and the three outcomes', () => {
  assert.ok(
    doc.includes(
      'anycubic/anycubicCloud/v1/{slicer|web}/printer/<modeId>/<deviceId>/<type>',
    ),
  )
  assert.ok(
    doc.includes(
      'anycubic/anycubicCloud/v1/{slicer|web}/printer/public/<modeId>/<deviceId>/#',
    ),
  )
  for (const type of [
    '`info`',
    '`status`',
    '`print`',
    '`tempature`',
    '`multiColorBox`',
    '`light`',
    '`fan`',
    '`file`',
    '`axis`',
    '`skip`',
    '`video`',
  ]) {
    assert.ok(doc.includes(type), `message type ${type} missing`)
  }
  assert.match(
    doc,
    /empty `type` and empty\s+`action`, `code` 0, and the request's `msgid`/,
  )
  assert.match(doc, /Confirmed/)
  assert.match(doc, /Refused/)
  assert.match(doc, /Received without result/)
})

test('print start documents filepath "/" and the 10111 end-of-task trap', () => {
  assert.match(doc, /`filepath` \| `\/` \|/)
  assert.match(doc, /10111/)
  assert.match(doc, /`ams_settings\.ams_box_mapping`/)
  assert.match(doc, /`task_settings`/)
  assert.match(doc, /`taskid` \| `"-1"`/)
})

test('lists every job phase reported by the printer', () => {
  for (const phase of [
    'checking',
    'printing',
    'hotbed_heating',
    'nozzle_heating',
    'ace_filament_unfeeding',
    'ace_filament_feeding',
    'nozzle_purging',
    'nozzle_wiping',
    'nozzle_cooling',
    'auto_leveling',
    'z_offset_calibrating',
    'frequency_sweeping',
    'hotbed_cooling_off',
    'nozzle_cooling_off',
    'finished',
  ]) {
    assert.ok(doc.includes(`\`${phase}\``), `job phase ${phase} missing`)
  }
})

test('covers ACE box and slot fields and the camera URL shape', () => {
  for (const field of [
    '`auto_feed`',
    '`drying_status`',
    '`humidity`',
    '`temp`',
    '`loaded_slot`',
    '`model_id`',
    '`brand_name`',
    '`color`',
    '`consumables_percent`',
    '`material_name`',
    '`status`',
    '`type`',
    '`weight`',
  ]) {
    assert.ok(doc.includes(field), `ACE field ${field} missing`)
  }
  assert.ok(doc.includes('http://<printer-ip>:18088/live/<token>'))
  assert.match(doc, /urls\.rtspUrl/)
})

test('states firmware scope 2.0.2.8 with verified and unverified lists', () => {
  assert.match(doc, /firmware 2\.0\.2\.8/)
  assert.match(doc, /### Verified on firmware 2\.0\.2\.8/)
  assert.match(doc, /### Unverified items/)
  const unverifiedNeeded = [
    'Pause, resume, stop',
    'Filament feed and retract',
    'Drying start and stop',
    'Slot edit',
    'Skip objects',
    'Speed mode',
    'Spoolman booking',
    'Flow calibration and time-lapse in `print/start`',
    '`file/deleteVideo`',
    'The `sign` computation for `POST /ctrl`',
    'The AES key and IV for the credential blob',
    'The multipart field name for `gcode_upload`',
  ]
  const unverified = doc
    .split('### Unverified items')[1]
    .split('## Security notes')[0]
  for (const item of unverifiedNeeded) {
    assert.ok(unverified.includes(item), `unverified item "${item}" not listed`)
  }
})

test('every protocol section carries an observed, reported or not verified status', () => {
  const protocolSections = sectionBodies().filter(
    (s) =>
      ![
        'Purpose and clean-room rules',
        'Status and source legend',
        'Security notes',
        'Sources',
      ].includes(s.title),
  )
  assert.ok(protocolSections.length >= 8)
  for (const section of protocolSections) {
    assert.match(
      section.body,
      /observed|reported|not verified|unverified/,
      `section "${section.title}" has no status tag`,
    )
  }
})

test('credits every source with its license and keeps GPL and AGPL facts reported only', () => {
  const sources = doc.split('## Sources')[1]
  for (const source of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    assert.ok(sources.includes(source), `source ${source} not credited`)
  }
  assert.match(sources, /Kobralink.*GPL-3\.0/)
  assert.match(sources, /KX-Bridge.*GPL-3\.0/)
  assert.match(sources, /anycubic-orca-plugin.*AGPL-3\.0/)
  assert.match(sources, /Anycubic proprietary/)
  assert.match(sources, /No binary content is reproduced/)
})

test('contains no code: only text blocks and no source-code constructs', () => {
  const fences = [...doc.matchAll(/^```([^\n]*)$/gm)].map((m) => m[1].trim())
  assert.ok(fences.length % 2 === 0, 'unbalanced code fences')
  for (const lang of fences.filter((_, i) => i % 2 === 0)) {
    assert.equal(lang, 'text', `code fence must be text, found "${lang}"`)
  }
  assert.doesNotMatch(
    doc,
    /^\s*(import |from \S+ import |def |function |const |let |var |class |return |if \(|for \()/m,
  )
  assert.doesNotMatch(doc, /=>|\{\s*\n\s*\w+\s*:\s*\w+,?\s*\n\s*\}/)
})

test('contains no key, certificate, private path, real address, email or AI attribution', () => {
  assert.doesNotMatch(doc, /-----BEGIN|-----END/)
  assert.doesNotMatch(doc, /\/Users\/|\/home\/|~\/|Developer\/github|\.t3\//)
  assert.doesNotMatch(doc, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  assert.doesNotMatch(doc, /[A-Fa-f0-9]{32,}/)
  const addresses = [...doc.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)].map(
    (m) => m[0],
  )
  assert.deepEqual(
    // 2.0.2.8 (printer firmware) and 2.0.0.3 (slicer version) are versions, not addresses.
    [...new Set(addresses)].filter(
      (a) => !['239.255.255.250', '2.0.2.8', '2.0.0.3'].includes(a),
    ),
    [],
    'only the SSDP multicast group may appear as a literal address',
  )
  assert.doesNotMatch(
    doc,
    /\bClaude\b|\bAnthropic\b|\bLLM\b|\bGPT\b|🤖|Co-Authored-By|Generated with/i,
  )
})

test('internal links resolve to headings in the document', () => {
  const links = [...doc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1])
  assert.ok(links.length > 0)
  for (const anchor of links) {
    assert.ok(headingSlugs.has(anchor), `anchor #${anchor} has no heading`)
  }
})
