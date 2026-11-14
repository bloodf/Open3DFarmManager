import { describe, expect, it } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  validateUpload,
} from '../../apps/farm/app/utils/files-view.ts'
describe('upload validation', () => {
  it('accepts supported files through the size limit', () => {
    expect(
      validateUpload({ name: 'peca.GCODE', size: MAX_UPLOAD_BYTES }),
    ).toBeUndefined()
    expect(validateUpload({ name: 'peca.3mf', size: 1 })).toBeUndefined()
  })
  it('rejects invalid extension and sizes before sending', () => {
    for (const file of [
      { name: 'x.exe', size: 1 },
      { name: 'x.gcode', size: 0 },
      { name: 'x.3mf', size: MAX_UPLOAD_BYTES + 1 },
      { name: 'x.gcode', size: NaN },
    ])
      expect(validateUpload(file)).toBeTypeOf('string')
  })
})
