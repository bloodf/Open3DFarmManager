import { describe, expect, it } from 'vitest'
import { anycubicCatalog } from '../../apps/farm/app/utils/compatibility/anycubic'

describe('catálogo Anycubic', () => {
  it('lista cinco modelos base distintos com identificadores e informações úteis', () => {
    expect(anycubicCatalog).toHaveLength(5)
    expect(new Set(anycubicCatalog.map((item) => item.id)).size).toBe(5)
    expect(new Set(anycubicCatalog.map((item) => item.model)).size).toBe(5)
    expect(anycubicCatalog.map((item) => item.model)).toEqual([
      'Kobra 3 Max V2',
      'Kobra 4',
      'Kobra X',
      'Kobra S1 Max',
      'Kobra 3 V2',
    ])
    for (const item of anycubicCatalog) {
      expect(item.brand).toBe('Anycubic')
      expect(item.releaseStatus.length).toBeGreaterThan(10)
      expect(item.connection.length).toBeGreaterThan(10)
      expect(item.limitations.length).toBeGreaterThan(0)
      expect(
        item.sources.every((source) => new URL(source).protocol === 'https:'),
      ).toBe(true)
    }
  })

  it('mantém datas, firmware e capacidades não comprovadas conservadores', () => {
    for (const item of anycubicCatalog) {
      expect(item.releaseDate).toBeNull()
      // O rótulo antigo de firmware desconhecido foi substituído pelo rótulo
      // explícito de versão não verificada; a Kobra X publica versões, mas
      // nenhuma foi qualificada em hardware.
      expect(item.firmwareStatus).toMatch(/não verificado|não qualificadas/)
      expect(item.firmwareStatus).not.toContain('desconhecida')
      expect(item.firmwareStatus.length).toBeGreaterThan(10)
      for (const [capability, status] of Object.entries(item.capabilities)) {
        if (status === 'documented')
          expect(item.sources.length).toBeGreaterThan(0)
        if (status === 'simulated')
          expect(item.limitations.length).toBeGreaterThan(0)
        const expected =
          item.model === 'Kobra X'
            ? // Telemetry is hardware-proven from a real Kobra X; files, pause,
              // materials, resume and cancel stay simulated; the rest unknown.
              capability === 'telemetry'
              ? 'hardware'
              : ['files', 'materials', 'pause', 'resume', 'cancel'].includes(
                    capability,
                  )
                ? 'simulated'
                : 'unknown'
            : 'unknown'
        expect(status).toBe(expected)
      }
    }
  })
})
