import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compatibilityPageCatalog } from '../../apps/farm/app/utils/compatibility'

/**
 * Um status `hardware` só existe com um relatório gravado de
 * `scripts/qualify-printer.ts` que casa com o produto e comprova a capacidade.
 */
const repo = (path: string) => resolve(import.meta.dirname, '../..', path)
const reportDir = 'docs/hardware-reports'
const readOnlyProvable = ['telemetry', 'files', 'camera']

describe('promoção do catálogo por hardware', () => {
  it('liga cada status hardware a um relatório que o comprova', () => {
    let promoted = 0
    for (const product of compatibilityPageCatalog) {
      for (const status of Object.values(product.controlAreas))
        expect(status, `${product.id} área de controle`).not.toBe('hardware')
      for (const [capability, status] of Object.entries(product.capabilities)) {
        const reports =
          product.hardwareReports?.[capability as 'telemetry'] ?? []
        if (status !== 'hardware') {
          expect(reports, `${product.id}.${capability}`).toEqual([])
          continue
        }
        promoted++
        expect(readOnlyProvable, `${product.id}.${capability}`).toContain(
          capability,
        )
        expect(reports.length, `${product.id}.${capability}`).toBeGreaterThan(0)
        for (const path of reports) {
          expect(path).toMatch(/^docs\/hardware-reports\/[\w.-]+\.json$/)
          const report = JSON.parse(readFileSync(repo(path), 'utf8'))
          expect(report.catalog.matchedCatalogId, path).toBe(product.id)
          expect(report.catalog.provenCapabilities[capability], path).toBe(true)
          expect(report.qualification.status, path).not.toBe('unreachable')
        }
      }
    }
    expect(promoted).toBeGreaterThan(0)
  })

  it('guarda relatórios sem endereços nem credenciais', () => {
    const files = readdirSync(repo(reportDir)).filter((name) =>
      name.endsWith('.json'),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const report = JSON.parse(
        readFileSync(repo(`${reportDir}/${name}`), 'utf8'),
      )
      expect(report.host, name).toBe('<printer-host>')
      // Scan every string value except the firmware version, which can look
      // like an IPv4 address (e.g. "2.0.2.8") without being one.
      const scan = { ...report, identity: { ...report.identity, firmware: '' } }
      const text = JSON.stringify(scan)
      expect(text, name).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
      expect(text, name).not.toMatch(
        /apiKey|accessCode|password|token|https?:\/\//i,
      )
    }
  })
})
