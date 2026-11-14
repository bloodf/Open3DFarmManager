import { z } from 'zod'
import { readPrivateJsonFile } from '../config/local.ts'
import type { BambuBinding } from './configuration.ts'

const Credential = z.strictObject({ accessCode: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u) })

export function readBambuCredentials(binding: BambuBinding) {
  try {
    const credential = Credential.parse(readPrivateJsonFile(binding.credentialFile, { maxBytes: 4096, maxStringChars: 256 }))
    return { username: 'bblp', password: credential.accessCode }
  } catch {
    throw new Error('Invalid Bambu credentials')
  }
}
