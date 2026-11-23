import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { SpoolmanConfigurationTarget } from '../../../farm-protocol/src/configuration-target.ts'
import { readAgentRuntimeConfig } from '../config/runtime.ts'
import {
  SpoolmanCredential,
  spoolmanAuthorization,
} from '../spoolman/credential.ts'
import type { CommitPlan } from './journal.ts'
import {
  ensurePrivateDirectory,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomic,
} from './private-fs.ts'
import type { RuntimeScope } from './runtime-commit.ts'

/** Result of one Connector-side connection test. Never carries remote detail. */
export type SpoolmanTestResult = 'reachable' | 'unreachable' | 'unauthorized'

const TEST_TIMEOUT_MS = 5000
const MAX_TEST_BYTES = 256 * 1024

/**
 * Spoolman has no auth of its own; installs sit behind a reverse proxy, so a
 * 401/403 on the very endpoint inventory collection uses is "unauthorized".
 * Redirects are errors, bodies are bounded, and nothing remote is echoed.
 */
export async function testSpoolmanConnection(input: {
  origin: string
  credential?: Pick<SpoolmanCredential, 'token' | 'username' | 'password'>
  fetch?: typeof fetch
  timeoutMs?: number
}): Promise<SpoolmanTestResult> {
  const request = input.fetch ?? fetch
  const authorization = input.credential
    ? spoolmanAuthorization(input.credential)
    : undefined
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? TEST_TIMEOUT_MS,
  )
  try {
    const url = new URL('/api/v1/spool', input.origin)
    url.search = new URLSearchParams({ limit: '1' }).toString()
    const response = await request(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(authorization ? { authorization } : {}),
      },
    })
    try {
      if (response.status === 401 || response.status === 403)
        return 'unauthorized'
      if (
        response.status !== 200 ||
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        return 'unreachable'
      const text = await boundedText(response, MAX_TEST_BYTES)
      return Array.isArray(JSON.parse(text)) ? 'reachable' : 'unreachable'
    } finally {
      void response.body?.cancel().catch(() => {})
    }
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error('too large')
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

export function spoolmanIdentity(origin: string) {
  const digest = createHash('sha256')
    .update(new URL(origin).origin)
    .digest('base64url')
  const deviceId = /^[A-Za-z0-9]/.test(digest) ? digest : `s${digest}`
  return { bridge_instance_id: 'spoolman-' + digest, device_id: deviceId }
}
/** Operation-scoped staging file, written at prepare and removed on cancel. */
export function spoolmanStagedPath(directory: string, operationId: string) {
  return join(directory, 'credentials', `${operationId}.spoolman.json`)
}
/** The single live file the collector reads. Replaced atomically at commit. */
export function spoolmanCredentialPath(directory: string) {
  return join(directory, 'credentials', 'spoolman.json')
}

function credentialOf(target: SpoolmanConfigurationTarget): SpoolmanCredential {
  return {
    origin: new URL(target.origin).origin,
    ...(target.token ? { token: target.token } : {}),
    ...(target.username && target.password
      ? { username: target.username, password: target.password }
      : {}),
  }
}

/**
 * Stages the credentials privately, then runs the connection test. A failed
 * test leaves nothing staged. Credentials never enter the journal.
 */
export async function prepareSpoolman(
  directory: string,
  operationId: string,
  target: SpoolmanConfigurationTarget,
  fetchImpl?: typeof fetch,
): Promise<
  | { ok: true }
  | { ok: false; code: 'spoolman-unreachable' | 'spoolman-unauthorized' }
> {
  const credential = credentialOf(target)
  ensurePrivateDirectory(join(directory, 'credentials'))
  const path = spoolmanStagedPath(directory, operationId)
  writePrivateJsonAtomic(path, credential)
  const result = await testSpoolmanConnection({
    origin: credential.origin,
    credential,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  if (result === 'reachable') return { ok: true }
  removePrivateFile(path)
  return {
    ok: false,
    code:
      result === 'unauthorized'
        ? 'spoolman-unauthorized'
        : 'spoolman-unreachable',
  }
}

const Runtime = z.looseObject({
  version: z.number().int().min(1).max(5),
  collection: z.looseObject({
    version: z.number().int().min(1).max(5),
    spoolman: z.looseObject({}).optional(),
  }),
  assignments: z.array(z.unknown()),
})
function runtime(scope: RuntimeScope) {
  const raw = readPrivateJson(scope.runtimeConfigPath)
  // A Spoolman setting only decorates an existing runtime; it never invents one.
  if (raw === null) throw new Error('Runtime configuration missing')
  return Runtime.parse(raw)
}
const Current = z.looseObject({
  origin: z.string(),
  serviceId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  credentialFile: z.string().optional(),
})
function currentSpoolman(scope: RuntimeScope) {
  const parsed = Current.safeParse(runtime(scope).collection.spoolman)
  return parsed.success ? parsed.data : null
}

/** True when the runtime already carries exactly this origin and credential file. */
export function spoolmanRuntimeContains(
  scope: RuntimeScope,
  origin: string,
  plan: CommitPlan,
): boolean {
  const current = currentSpoolman(scope)
  return (
    current !== null &&
    current.origin === origin &&
    current.credentialFile === plan.credential_file
  )
}

/**
 * Publishes the credential file, then the runtime section, each atomically.
 * Re-running after a crash is idempotent. The collection validator runs on the
 * candidate before publication so a bad file never becomes the runtime.
 */
export function commitSpoolman(
  scope: RuntimeScope,
  origin: string,
  plan: CommitPlan,
  stagedPath: string,
) {
  const current = runtime(scope)
  const staged = SpoolmanCredential.parse(readPrivateJson(stagedPath))
  if (staged.origin !== origin)
    throw new Error('Spoolman credential origin mismatch')
  writePrivateJsonAtomic(plan.credential_file, staged)
  const previous = Current.safeParse(current.collection.spoolman)
  const next = {
    ...current,
    collection: {
      ...current.collection,
      spoolman: {
        origin,
        farmId: scope.farm_id,
        serviceId:
          (previous.success && previous.data.origin === origin
            ? previous.data.serviceId
            : undefined) ?? randomUUID(),
        limit: (previous.success ? previous.data.limit : undefined) ?? 200,
        credentialFile: plan.credential_file,
      },
    },
  }
  writePrivateJsonAtomic(scope.runtimeConfigPath, next, (path) => {
    readAgentRuntimeConfig(path, scope)
  })
}
