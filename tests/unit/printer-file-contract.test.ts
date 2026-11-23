import { expect, it } from 'vitest'
import { FileListResponse } from '../../packages/farm-protocol/src/file-list.ts'

const file = { name: 'Part v2.GCODE', size: 42, modified: 0 }

function decode(entry: Record<string, unknown>) {
  return FileListResponse.safeParse(
    JSON.parse(
      JSON.stringify({
        type: 'files.list.result',
        request_id: 'request',
        printer_key: 'printer',
        ok: true,
        files: [entry],
      }),
    ),
  )
}

it.each([
  file,
  { ...file, printRef: `kobralink-library:${'a'.repeat(128)}` },
  { ...file, printRef: 'creality-udisk:Part v2.GCODE' },
  { ...file, printRef: `creality-udisk:${'a'.repeat(234)}.gcode` },
])('preserves valid file entries on the wire (%j)', (entry) => {
  expect(decode(entry)).toMatchObject({
    success: true,
    data: { files: [entry] },
  })
})

it.each([
  'creality-udisk:/mnt/UDISK/part.gcode',
  'creality-udisk:subdir\\part.gcode',
  'creality-udisk:part..gcode',
  'creality-udisk:part.gcode\n',
  'creality-udisk:part.gcode.zip',
  'creality-udisk:.hidden.gcode',
  'CREALITY-UDISK:part.gcode',
  `creality-udisk:${'a'.repeat(235)}.gcode`,
  'kobralink-library:../file',
  'kobralink-library:',
  `kobralink-library:${'a'.repeat(129)}`,
  'unknown:part.gcode',
])('rejects an invalid print reference (%j)', (printRef) => {
  expect(decode({ ...file, printRef }).success).toBe(false)
})

it('still rejects extra file properties', () => {
  expect(decode({ ...file, path: '/mnt/UDISK/part.gcode' }).success).toBe(false)
})
