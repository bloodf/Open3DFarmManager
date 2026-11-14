import { describe, expect, it } from 'vitest'
import { anycubicCatalog } from '../../apps/farm/app/utils/compatibility/anycubic'

describe('catálogo Anycubic', () => {
  it('lista cinco modelos base distintos com identificadores e informações úteis', () => {
    expect(anycubicCatalog).toHaveLength(5)
    expect(new Set(anycubicCatalog.map((item) => item.id)).size).toBe(5)
    expect(new Set(anycubicCatalog.map((item) => item.model)).size).toBe(5)
    expect(anycubicCatalog.map((item) => item.model)).toEqual([
      'Kobra 3 Max V2', 'Kobra 4', 'Kobra X', 'Kobra S1 Max', 'Kobra 3 V2',
    ])
    for (const item of anycubicCatalog) {
      expect(item.brand).toBe('Anycubic')
      expect(item.releaseStatus.length).toBeGreaterThan(10)
      expect(item.connection.length).toBeGreaterThan(10)
      expect(item.limitations.length).toBeGreaterThan(0)
      expect(item.sources.every((source) => new URL(source).protocol === 'https:')).toBe(true)
    }
  })

  it('mantém datas, firmware e capacidades não comprovadas conservadores', () => {
    for (const item of anycubicCatalog) {
      expect(item.releaseDate).toBeNull()
      expect(item.firmwareStatus).toContain('desconhecida')
      for (const [capability, status] of Object.entries(item.capabilities)) {
        expect(status).toBe(item.model === 'Kobra X' && capability === 'telemetry' ? 'simulated' : 'unknown')
      }
    }
  })
})
