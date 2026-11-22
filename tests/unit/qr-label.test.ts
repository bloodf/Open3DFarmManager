import assert from 'node:assert/strict'
import { test } from 'vitest'
import { encode, renderSVG } from 'uqr'
import { labelQr } from '../../apps/farm/server/utils/qr/label.ts'

test('QR matrix encodes its byte payload', () => {
  // Version 2-L fits this URL in a single Reed-Solomon block. Read the data
  // modules in the QR zigzag order, independently reversing mask pattern 0.
  const url = 'https://farm.test/'
  const qr = encode(url, {
    ecc: 'L',
    boostEcc: false,
    maskPattern: 0,
    border: 0,
  })
  assert.equal(qr.version, 2)
  const bits: number[] = []
  for (let right = qr.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < qr.size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? qr.size - 1 - vertical : vertical
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset
        if (qr.types[y]![x] === 0)
          bits.push(Number(qr.data[y]![x]) ^ Number((x + y) % 2 === 0))
      }
    }
  }
  let at = 0
  const read = (n: number) => {
    let v = 0
    while (n--) v = (v << 1) | bits[at++]!
    return v
  }
  assert.equal(read(4), 4)
  const length = read(8)
  assert.equal(
    Buffer.from(Array.from({ length }, () => read(8))).toString('utf8'),
    url,
  )
  const svg = labelQr(url)
  assert.match(svg, /<svg/)
  assert.equal(svg, renderSVG(url, { border: 4, ecc: 'M' }))
  assert.notEqual(svg, labelQr('https://farm.test/other'))
})
