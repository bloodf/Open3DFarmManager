import { test, expect } from 'bun:test'
import { parsePairingResponse } from '@open3dfarmmanager/farm-protocol'
import {
  parseMoonrakerServerInfo,
  parseMoonrakerSnapshot,
} from '../../packages/connector/src/moonraker/parse.ts'
import { parseSpoolmanVendors } from '../../packages/connector/src/spoolman/read.ts'
const id = '00000000-0000-4000-8000-000000000001'

test('all integrated external JSON decoders reject escaped duplicate fields', () => {
  expect(() =>
    parsePairingResponse('{"status":"denied","\\u0073tatus":"expired"}'),
  ).toThrow('duplicate-key')
  expect(() =>
    parseMoonrakerServerInfo(
      '{"result":{"klippy_connected":false,"klippy_connected":true,"klippy_state":"ready"}}',
    ),
  ).toThrow('invalid-frame')
  expect(() =>
    parseMoonrakerSnapshot(
      '{"result":{"eventtime":1,"eventtime":2,"status":{}}}',
      { printerKey: 'synthetic', observedAt: 1000 },
    ),
  ).toThrow('invalid-frame')
  expect(() =>
    parseSpoolmanVendors('[{"id":1,"\\u0069d":2}]', {
      farmId: id,
      serviceId: id,
      observedAt: 1000,
      offset: 0,
      limit: 10,
    }),
  ).toThrow('invalid-frame')
})
