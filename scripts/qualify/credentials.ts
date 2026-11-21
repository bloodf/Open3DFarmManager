// SPDX-License-Identifier: MIT
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface ParsedCredentials {
  apiKey?: string
  accessCode?: string
  username?: string
  password?: string
  serial?: string
  caPem?: string
  pinSha256?: string
  name?: string
  email?: string
  certFile?: string
  keyFile?: string
}

export function loadCredentials(filePath?: string): ParsedCredentials {
  if (!filePath) return {}
  const target = isAbsolute(filePath)
    ? filePath
    : resolve(process.cwd(), filePath)
  try {
    const stat = statSync(target)
    if (!stat.isFile()) throw new Error('Credential path is not a regular file')
    if (stat.size > 64 * 1024)
      throw new Error('Credential file exceeds 64KB limit')
    const raw = readFileSync(target, 'utf8').trim()
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const result: ParsedCredentials = {}
        if (typeof parsed.apiKey === 'string')
          result.apiKey = parsed.apiKey.trim()
        if (typeof parsed.accessCode === 'string')
          result.accessCode = parsed.accessCode.trim()
        if (typeof parsed.username === 'string')
          result.username = parsed.username.trim()
        if (typeof parsed.password === 'string')
          result.password = parsed.password.trim()
        if (typeof parsed.serial === 'string')
          result.serial = parsed.serial.trim()
        if (typeof parsed.pinSha256 === 'string')
          result.pinSha256 = parsed.pinSha256.trim()
        if (typeof parsed.name === 'string') result.name = parsed.name.trim()
        if (typeof parsed.email === 'string') result.email = parsed.email.trim()
        if (typeof parsed.certFile === 'string')
          result.certFile = parsed.certFile.trim()
        if (typeof parsed.keyFile === 'string')
          result.keyFile = parsed.keyFile.trim()
        if (typeof parsed.caPem === 'string') result.caPem = parsed.caPem
        if (typeof parsed.caFile === 'string') {
          try {
            const caPath = isAbsolute(parsed.caFile)
              ? parsed.caFile
              : resolve(process.cwd(), parsed.caFile)
            result.caPem = readFileSync(caPath, 'utf8')
          } catch {}
        }
        return result
      }
    } catch {
      // Plain text token / key fallback
      return { accessCode: raw, apiKey: raw }
    }
    return {}
  } catch (error) {
    throw new Error(
      `Failed to read credential file: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}
