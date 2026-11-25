import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  basename,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
  win32,
} from 'node:path'
import { z } from 'zod'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import type { ConfigurationErrorCode } from '../../../farm-protocol/src/configuration-frames.ts'
import type { KobraClientCertificateInput } from '../../../farm-protocol/src/configuration-target.ts'
import {
  validateKobraClientCertificate,
  type KobraClientCertErrorReason,
  type KobraClientCertMetadata,
} from '../../../shared/src/kobra-client-cert.ts'
import {
  ensurePrivateDirectory,
  removePrivateFile,
  writePrivateJsonAtomic,
} from '../provisioning/private-fs.ts'
import { readPrivateJsonFile } from './local.ts'
import { bundledKobraClientIdentity } from './kobra-x-default-cert.ts'

export const KOBRA_CLIENT_CERT_MAX_BYTES = 32 * 1024
export const KOBRA_CLIENT_CERT_MAX_STRING_CHARS = 8192
const MAX_SOURCE_FILE_BYTES = 128 * 1024
const MAX_SCAN_DEPTH = 4
const MAX_SCAN_ENTRIES = 512

export const ANYCUBIC_SLICER_NEXT_TYPICAL_PATHS = Object.freeze({
  darwin: '/Applications/AnycubicSlicerNext.app/Contents/Resources',
  win32: 'C:\\Program Files\\AnycubicSlicerNext\\resources',
  linux: '/opt/AnycubicSlicerNext/resources',
})

export const KOBRA_INSTALL_PATH_ERROR_CODE: ConfigurationErrorCode =
  'client-cert-missing'

export interface KobraInstallPathPolicyOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  localAppData?: string
}

function safeHomeDir(override?: string): string | null {
  if (override !== undefined) return override.trim() || null
  try {
    const value = homedir().trim()
    return value || null
  } catch {
    return null
  }
}

function isPathWithinRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'win32') {
    const resolvedRoot = win32.resolve(root)
    const resolvedCandidate = win32.resolve(candidate)
    const rel = win32.relative(
      resolvedRoot.toLowerCase(),
      resolvedCandidate.toLowerCase(),
    )
    return (
      rel === '' ||
      (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel))
    )
  }
  const resolvedRoot = posix.resolve(root)
  const resolvedCandidate = posix.resolve(candidate)
  const rel = posix.relative(resolvedRoot, resolvedCandidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  )
}

export function allowedKobraInstallRoots(
  options: KobraInstallPathPolicyOptions = {},
): readonly string[] {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    return ['/Applications/AnycubicSlicerNext.app']
  }
  if (platform === 'linux') {
    const roots = ['/opt/AnycubicSlicerNext']
    const home = safeHomeDir(options.homeDir)
    if (home && posix.isAbsolute(home)) {
      const resolvedHome = posix.resolve(home)
      if (resolvedHome !== '/') {
        roots.push(
          posix.join(resolvedHome, '.local', 'share', 'AnycubicSlicerNext'),
        )
      }
    }
    return roots
  }
  if (platform === 'win32') {
    const roots = ['C:\\Program Files\\AnycubicSlicerNext']
    const rawLocalAppData =
      options.localAppData !== undefined
        ? options.localAppData.trim()
        : (process.env.LOCALAPPDATA?.trim() ?? '')
    if (
      rawLocalAppData &&
      !/^(?:\\\\|\/\/)/.test(rawLocalAppData) &&
      win32.isAbsolute(rawLocalAppData)
    ) {
      roots.push(
        win32.join(win32.resolve(rawLocalAppData), 'AnycubicSlicerNext'),
      )
    } else {
      const home = safeHomeDir(options.homeDir)
      if (home && !/^(?:\\\\|\/\/)/.test(home) && win32.isAbsolute(home)) {
        roots.push(
          win32.join(
            win32.resolve(home),
            'AppData',
            'Local',
            'AnycubicSlicerNext',
          ),
        )
      }
    }
    return roots
  }
  return []
}

function matchAllowedInstallRoot(
  rawPath: string,
  options: KobraInstallPathPolicyOptions = {},
): { root: string; resolved: string } | null {
  const platform = options.platform ?? process.platform
  const trimmed = rawPath.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (platform === 'win32') {
    if (/^(?:\\\\|\/\/)/.test(trimmed) || !win32.isAbsolute(trimmed))
      return null
    const resolved = win32.resolve(trimmed)
    for (const root of allowedKobraInstallRoots(options)) {
      if (isPathWithinRoot(resolved, root, platform)) {
        return { root: win32.resolve(root), resolved }
      }
    }
    return null
  }
  if (!posix.isAbsolute(trimmed)) return null
  const resolved = posix.resolve(trimmed)
  for (const root of allowedKobraInstallRoots(options)) {
    if (isPathWithinRoot(resolved, root, platform)) {
      return { root: posix.resolve(root), resolved }
    }
  }
  return null
}

export function isAllowedKobraInstallPath(
  rawPath: string,
  options: KobraInstallPathPolicyOptions = {},
): boolean {
  return matchAllowedInstallRoot(rawPath, options) !== null
}

function hasNoSymlinkSegmentsBelow(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (!rel) return true
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  let cursor = root
  for (const segment of rel.split(sep)) {
    if (!segment) continue
    cursor = join(cursor, segment)
    const stat = lstatSync(cursor, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) return false
  }
  return true
}

export const StoredKobraClientCert = z.strictObject({
  version: z.literal(1),
  format: z.enum(['pem', 'pkcs12']),
  subject: z.string().min(1).max(1024),
  commonName: z.string().min(1).max(256),
  notBefore: z.number().int().nonnegative(),
  notAfter: z.number().int().positive(),
  notBeforeIso: z.string().min(1).max(64),
  notAfterIso: z.string().min(1).max(64),
  fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/),
  certificatePem: z.string().min(1).max(KOBRA_CLIENT_CERT_MAX_STRING_CHARS),
  keyPem: z.string().min(1).max(KOBRA_CLIENT_CERT_MAX_STRING_CHARS),
})
export type StoredKobraClientCert = z.infer<typeof StoredKobraClientCert>

export function certErrorCode(
  reason: KobraClientCertErrorReason,
): ConfigurationErrorCode {
  switch (reason) {
    case 'missing':
      return 'client-cert-missing'
    case 'unreadable':
      return 'client-cert-unreadable'
    case 'wrong-subject':
      return 'client-cert-wrong-subject'
    case 'expired':
      return 'client-cert-expired'
  }
}

export function kobraCredentialsDirectory(stateDirectory: string): string {
  return join(stateDirectory, 'credentials')
}

export function stagedKobraCertPath(
  stateDirectory: string,
  operationId: string,
): string {
  return join(
    kobraCredentialsDirectory(stateDirectory),
    `${operationId}.kobra-cert.json`,
  )
}

export function assignmentKobraCertPath(
  stateDirectory: string,
  assignmentId: string,
): string {
  return join(
    kobraCredentialsDirectory(stateDirectory),
    `${assignmentId}.kobra-cert.json`,
  )
}

export function kobraClientCertPath(stateDirectory: string): string {
  return join(
    kobraCredentialsDirectory(stateDirectory),
    'kobra-x-client-cert.json',
  )
}

export function discardStagedKobraCert(
  stateDirectory: string,
  operationId: string,
): void {
  removePrivateFile(stagedKobraCertPath(stateDirectory, operationId))
}

function decodeBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function readBoundedFileBytes(filePath: string): Uint8Array | null {
  try {
    const stat = lstatSync(filePath, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null
    if (stat.size <= 0 || stat.size > MAX_SOURCE_FILE_BYTES) return null
    const buf = readFileSync(filePath)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch {
    return null
  }
}

function collectCandidateFiles(
  rootDir: string,
  state: {
    seen: number
    certFiles: string[]
    keyFiles: string[]
    p12Files: string[]
  },
  depth: number,
): void {
  if (depth > MAX_SCAN_DEPTH || state.seen >= MAX_SCAN_ENTRIES) return
  let entries: Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (state.seen >= MAX_SCAN_ENTRIES) break
    state.seen++
    if (entry.isSymbolicLink()) continue
    const full = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      collectCandidateFiles(full, state, depth + 1)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (ext === '.p12' || ext === '.pfx') {
        state.p12Files.push(full)
      } else if (ext === '.pem' || ext === '.crt' || ext === '.cer') {
        state.certFiles.push(full)
      } else if (ext === '.key') {
        state.keyFiles.push(full)
      }
    }
  }
}

export type KobraClientCertImportResult =
  | {
      ok: true
      cert: StoredKobraClientCert
    }
  | {
      ok: false
      reason: KobraClientCertErrorReason
      message: string
      metadata?: Partial<KobraClientCertMetadata> | undefined
    }

const KOBRA_INSTALL_PATH_ERROR: Extract<
  KobraClientCertImportResult,
  { ok: false }
> = Object.freeze({
  ok: false,
  reason: 'missing',
  message:
    'Não foi possível importar o certificado do cliente a partir do caminho informado do Anycubic Slicer Next.',
})

export async function importKobraClientCertFromInput(
  input: KobraClientCertificateInput,
  now = Date.now(),
): Promise<KobraClientCertImportResult> {
  if (input.kind === 'inline') {
    const validated =
      input.format === 'pem'
        ? await validateKobraClientCertificate({
            text: `${input.certificate_pem ?? ''}\n${input.key_pem ?? ''}`,
            passphrase: input.passphrase,
            now,
          })
        : await validateKobraClientCertificate({
            bytes: decodeBase64(input.pkcs12_base64 ?? ''),
            passphrase: input.passphrase,
            now,
          })
    if (!validated.ok) {
      return {
        ok: false,
        reason: validated.reason,
        message: validated.message,
        ...(validated.metadata ? { metadata: validated.metadata } : {}),
      }
    }
    return {
      ok: true,
      cert: StoredKobraClientCert.parse({
        version: 1,
        format: validated.format,
        subject: validated.metadata.subject,
        commonName: validated.metadata.commonName,
        notBefore: validated.metadata.notBefore,
        notAfter: validated.metadata.notAfter,
        notBeforeIso: validated.metadata.notBeforeIso,
        notAfterIso: validated.metadata.notAfterIso,
        fingerprintSha256: validated.metadata.fingerprintSha256,
        certificatePem: validated.certificatePem,
        keyPem: validated.keyPem,
      }),
    }
  }

  const matched = matchAllowedInstallRoot(input.path)
  if (!matched) {
    return KOBRA_INSTALL_PATH_ERROR
  }

  try {
    const rootStat = lstatSync(matched.root, { throwIfNoEntry: false })
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return KOBRA_INSTALL_PATH_ERROR
    }
    if (!hasNoSymlinkSegmentsBelow(matched.root, matched.resolved)) {
      return KOBRA_INSTALL_PATH_ERROR
    }
    const stat = lstatSync(matched.resolved, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) {
      return KOBRA_INSTALL_PATH_ERROR
    }
    const realRoot = realpathSync(matched.root)
    const realTarget = realpathSync(matched.resolved)
    if (!isPathWithinRoot(realTarget, realRoot, process.platform)) {
      return KOBRA_INSTALL_PATH_ERROR
    }

    if (stat.isFile()) {
      const bytes = readBoundedFileBytes(matched.resolved)
      if (!bytes) {
        return KOBRA_INSTALL_PATH_ERROR
      }
      const direct = await validateKobraClientCertificate({ bytes, now })
      if (direct.ok) {
        return {
          ok: true,
          cert: StoredKobraClientCert.parse({
            version: 1,
            format: direct.format,
            subject: direct.metadata.subject,
            commonName: direct.metadata.commonName,
            notBefore: direct.metadata.notBefore,
            notAfter: direct.metadata.notAfter,
            notBeforeIso: direct.metadata.notBeforeIso,
            notAfterIso: direct.metadata.notAfterIso,
            fingerprintSha256: direct.metadata.fingerprintSha256,
            certificatePem: direct.certificatePem,
            keyPem: direct.keyPem,
          }),
        }
      }
      // Check sibling .key file in the same directory when pointing at a cert file.
      const parentDir = join(matched.resolved, '..')
      if (isPathWithinRoot(parentDir, matched.root, process.platform)) {
        const base = basename(matched.resolved, extname(matched.resolved))
        const siblingCandidates = [
          join(parentDir, `${base}.key`),
          join(parentDir, `${base}.pem`),
          join(parentDir, 'client.key'),
          join(parentDir, 'private.key'),
        ]
        const certText = new TextDecoder('utf-8', { fatal: false }).decode(
          bytes,
        )
        for (const keyPath of siblingCandidates) {
          if (keyPath === matched.resolved) continue
          const keyBytes = readBoundedFileBytes(keyPath)
          if (!keyBytes) continue
          const keyText = new TextDecoder('utf-8', { fatal: false }).decode(
            keyBytes,
          )
          const paired = await validateKobraClientCertificate({
            text: `${certText}\n${keyText}`,
            now,
          })
          if (paired.ok) {
            return {
              ok: true,
              cert: StoredKobraClientCert.parse({
                version: 1,
                format: paired.format,
                subject: paired.metadata.subject,
                commonName: paired.metadata.commonName,
                notBefore: paired.metadata.notBefore,
                notAfter: paired.metadata.notAfter,
                notBeforeIso: paired.metadata.notBeforeIso,
                notAfterIso: paired.metadata.notAfterIso,
                fingerprintSha256: paired.metadata.fingerprintSha256,
                certificatePem: paired.certificatePem,
                keyPem: paired.keyPem,
              }),
            }
          }
        }
      }
      return KOBRA_INSTALL_PATH_ERROR
    }

    if (!stat.isDirectory()) {
      return KOBRA_INSTALL_PATH_ERROR
    }

    const scanState = {
      seen: 0,
      certFiles: [] as string[],
      keyFiles: [] as string[],
      p12Files: [] as string[],
    }
    const preferredSubdirs = [
      join(matched.resolved, 'Contents', 'Resources'),
      join(matched.resolved, 'resources'),
      join(matched.resolved, 'certs'),
      matched.resolved,
    ]
    const scannedDirs = new Set<string>()
    for (const dir of preferredSubdirs) {
      const dirStat = lstatSync(dir, { throwIfNoEntry: false })
      if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory())
        continue
      if (!hasNoSymlinkSegmentsBelow(matched.root, dir)) continue
      const real = realpathSync(dir)
      if (!isPathWithinRoot(real, realRoot, process.platform)) continue
      if (scannedDirs.has(real)) continue
      scannedDirs.add(real)
      collectCandidateFiles(dir, scanState, 0)
    }

    for (const certFile of scanState.certFiles) {
      const bytes = readBoundedFileBytes(certFile)
      if (!bytes) continue
      const direct = await validateKobraClientCertificate({ bytes, now })
      if (direct.ok) {
        return {
          ok: true,
          cert: StoredKobraClientCert.parse({
            version: 1,
            format: direct.format,
            subject: direct.metadata.subject,
            commonName: direct.metadata.commonName,
            notBefore: direct.metadata.notBefore,
            notAfter: direct.metadata.notAfter,
            notBeforeIso: direct.metadata.notBeforeIso,
            notAfterIso: direct.metadata.notAfterIso,
            fingerprintSha256: direct.metadata.fingerprintSha256,
            certificatePem: direct.certificatePem,
            keyPem: direct.keyPem,
          }),
        }
      }
      const certText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      for (const keyFile of scanState.keyFiles) {
        if (join(keyFile, '..') !== join(certFile, '..')) continue
        const keyBytes = readBoundedFileBytes(keyFile)
        if (!keyBytes) continue
        const keyText = new TextDecoder('utf-8', { fatal: false }).decode(
          keyBytes,
        )
        const paired = await validateKobraClientCertificate({
          text: `${certText}\n${keyText}`,
          now,
        })
        if (paired.ok) {
          return {
            ok: true,
            cert: StoredKobraClientCert.parse({
              version: 1,
              format: paired.format,
              subject: paired.metadata.subject,
              commonName: paired.metadata.commonName,
              notBefore: paired.metadata.notBefore,
              notAfter: paired.metadata.notAfter,
              notBeforeIso: paired.metadata.notBeforeIso,
              notAfterIso: paired.metadata.notAfterIso,
              fingerprintSha256: paired.metadata.fingerprintSha256,
              certificatePem: paired.certificatePem,
              keyPem: paired.keyPem,
            }),
          }
        }
      }
    }

    for (const p12File of scanState.p12Files) {
      const bytes = readBoundedFileBytes(p12File)
      if (!bytes) continue
      const res = await validateKobraClientCertificate({ bytes, now })
      if (res.ok) {
        return {
          ok: true,
          cert: StoredKobraClientCert.parse({
            version: 1,
            format: res.format,
            subject: res.metadata.subject,
            commonName: res.metadata.commonName,
            notBefore: res.metadata.notBefore,
            notAfter: res.metadata.notAfter,
            notBeforeIso: res.metadata.notBeforeIso,
            notAfterIso: res.metadata.notAfterIso,
            fingerprintSha256: res.metadata.fingerprintSha256,
            certificatePem: res.certificatePem,
            keyPem: res.keyPem,
          }),
        }
      }
    }

    return KOBRA_INSTALL_PATH_ERROR
  } catch {
    return KOBRA_INSTALL_PATH_ERROR
  }
}

export type KobraClientIdentitySource = 'file' | 'install' | 'bundled'

export interface ResolvedKobraClientIdentity {
  certPem: string
  keyPem: string
  source: KobraClientIdentitySource
}

/**
 * Resolve the Kobra X client identity for read-only tooling, newest override
 * first: an explicit user-supplied certificate file, then a local Anycubic
 * Slicer Next installation scan, then the bundled Anycubic Slicer default
 * (`kobra-x-default-cert.ts`). An explicit file the operator points at is
 * trusted as given; the installation scan reuses the validated loader. The
 * returned private key stays in memory and is never written or logged.
 */
export async function resolveKobraClientIdentity(
  options: {
    certFile?: string | undefined
    keyFile?: string | undefined
    installPath?: string | undefined
    platform?: NodeJS.Platform
    now?: number
  } = {},
): Promise<ResolvedKobraClientIdentity> {
  if (options.certFile) {
    const certBytes = readBoundedFileBytes(options.certFile)
    if (!certBytes)
      throw new Error('Kobra X certificate file is unreadable or too large')
    const keyPath = options.keyFile ?? options.certFile
    const keyBytes = readBoundedFileBytes(keyPath)
    if (!keyBytes)
      throw new Error('Kobra X key file is unreadable or too large')
    const decoder = new TextDecoder('utf-8', { fatal: false })
    return {
      certPem: decoder.decode(certBytes),
      keyPem: decoder.decode(keyBytes),
      source: 'file',
    }
  }

  const installPath =
    options.installPath ??
    ANYCUBIC_SLICER_NEXT_TYPICAL_PATHS[
      (options.platform ??
        process.platform) as keyof typeof ANYCUBIC_SLICER_NEXT_TYPICAL_PATHS
    ]
  if (installPath && isAllowedKobraInstallPath(installPath)) {
    const stat = lstatSync(installPath, { throwIfNoEntry: false })
    if (stat && !stat.isSymbolicLink()) {
      const imported = await importKobraClientCertFromInput(
        { kind: 'install-path', path: installPath },
        options.now,
      )
      if (imported.ok) {
        return {
          certPem: imported.cert.certificatePem,
          keyPem: imported.cert.keyPem,
          source: 'install',
        }
      }
    }
  }

  const bundled = bundledKobraClientIdentity()
  return { ...bundled, source: 'bundled' }
}

export async function stageKobraClientCert(
  stateDirectory: string,
  operationId: string,
  input: KobraClientCertificateInput,
  now = Date.now(),
): Promise<
  | { ok: true; stagedPath: string; cert: StoredKobraClientCert }
  | {
      ok: false
      reason: KobraClientCertErrorReason
      code: ConfigurationErrorCode
      message: string
    }
> {
  const imported = await importKobraClientCertFromInput(input, now)
  if (!imported.ok) {
    return {
      ok: false,
      reason: imported.reason,
      code: certErrorCode(imported.reason),
      message: imported.message,
    }
  }
  ensurePrivateDirectory(stateDirectory)
  ensurePrivateDirectory(kobraCredentialsDirectory(stateDirectory))
  const stagedPath = stagedKobraCertPath(stateDirectory, operationId)
  writeKobraClientCertFile(stagedPath, imported.cert)
  return { ok: true, stagedPath, cert: imported.cert }
}

export function writeKobraClientCertFile(
  path: string,
  cert: StoredKobraClientCert,
): void {
  const parsed = StoredKobraClientCert.parse(cert)
  writePrivateJsonAtomic(path, parsed, (temporaryPath) => {
    StoredKobraClientCert.parse(
      parseBoundedJson(readFileSync(temporaryPath, 'utf8'), {
        maxBytes: KOBRA_CLIENT_CERT_MAX_BYTES,
        maxDepth: 4,
        maxValues: 64,
        maxStringChars: KOBRA_CLIENT_CERT_MAX_STRING_CHARS,
      }),
    )
  })
}

export function readKobraClientCertMaterial(
  path: string,
  now = Date.now(),
):
  | { ok: true; cert: StoredKobraClientCert }
  | { ok: false; reason: KobraClientCertErrorReason } {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return { ok: false, reason: 'missing' }
  let raw: unknown
  try {
    raw = readPrivateJsonFile(path, {
      maxBytes: KOBRA_CLIENT_CERT_MAX_BYTES,
      maxStringChars: KOBRA_CLIENT_CERT_MAX_STRING_CHARS,
    })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const parsed = StoredKobraClientCert.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'unreadable' }
  if (parsed.data.commonName !== 'AnycubicSlicer')
    return { ok: false, reason: 'wrong-subject' }
  if (now < parsed.data.notBefore || now >= parsed.data.notAfter)
    return { ok: false, reason: 'expired' }
  return { ok: true, cert: parsed.data }
}

export function commitStagedKobraClientCert(
  stateDirectory: string,
  operationId: string,
  assignmentId: string,
): string | null {
  const stagedPath = stagedKobraCertPath(stateDirectory, operationId)
  const stat = lstatSync(stagedPath, { throwIfNoEntry: false })
  if (!stat) return null
  const loaded = readKobraClientCertMaterial(stagedPath)
  if (!loaded.ok) throw new Error('Staged client certificate invalid')
  ensurePrivateDirectory(kobraCredentialsDirectory(stateDirectory))
  const assignmentPath = assignmentKobraCertPath(stateDirectory, assignmentId)
  writeKobraClientCertFile(assignmentPath, loaded.cert)
  writeKobraClientCertFile(kobraClientCertPath(stateDirectory), loaded.cert)
  removePrivateFile(stagedPath)
  return assignmentPath
}
