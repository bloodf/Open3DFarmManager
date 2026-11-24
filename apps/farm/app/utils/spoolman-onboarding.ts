import { SpoolmanConfigurationTarget as SpoolmanTargetSchema } from '../../../../packages/farm-protocol/src/configuration-target.ts'
import { z } from 'zod'
import { CONFIGURATION_PROTOCOL } from '../../../../packages/farm-protocol/src/configuration-common.ts'

export type SpoolmanStatus = 'reachable' | 'unreachable' | 'unauthorized'
export type SpoolmanConnectorResult = {
  agentId: string
  /** `failed` means the Connector could not be reached to run the test. */
  status: SpoolmanStatus | 'failed'
  configured: boolean
  outcome?: 'unknown'
}

const VALIDATION_ERROR =
  'Informe a origem HTTP(S) do Spoolman, sem credenciais, caminho, consulta ou fragmento. Use usuário e senha, ou um token, não os dois.'

/** Pure form validation. Errors never include the submitted URL or secret. */
export function validateSpoolmanTargetInput(input: {
  origin: string
  serviceId?: string
  token?: string
  username?: string
  password?: string
}) {
  const serviceId = input.serviceId?.trim()
  if (serviceId && !z.string().uuid().safeParse(serviceId).success)
    return {
      ok: false,
      error: 'Informe um UUID válido para o serviço Spoolman.',
    } as const
  const parsed = SpoolmanTargetSchema.safeParse({
    v: 1,
    protocol: CONFIGURATION_PROTOCOL,
    backend: 'spoolman',
    model: { family: 'spoolman', provisional: true },
    origin: input.origin.trim(),
    ...(serviceId ? { service_id: serviceId.toLowerCase() } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.username ? { username: input.username } : {}),
    ...(input.password ? { password: input.password } : {}),
  })
  if (!parsed.success) return { ok: false, error: VALIDATION_ERROR } as const
  return {
    ok: true,
    target: { ...parsed.data, origin: new URL(parsed.data.origin).origin },
  } as const
}

export function withoutSpoolmanCredentials<
  T extends {
    backend: string
    token?: string | undefined
    username?: string | undefined
    password?: string | undefined
  },
>(target: T): Omit<T, 'token' | 'username' | 'password'> {
  const { token: _token, username: _user, password: _pass, ...safe } = target
  return safe
}

export function describeSpoolmanStatus(
  status: SpoolmanConnectorResult['status'],
) {
  switch (status) {
    case 'reachable':
      return 'Conectado'
    case 'unreachable':
      return 'Inacessível'
    case 'unauthorized':
      return 'Não autorizado'
    default:
      return 'Connector indisponível'
  }
}
export function describeSpoolmanResult(result: SpoolmanConnectorResult) {
  if (result.outcome === 'unknown')
    return 'O resultado da configuração é desconhecido. Verifique o Connector antes de tentar novamente.'
  switch (result.status) {
    case 'reachable':
      return result.configured
        ? 'Spoolman acessível e configurado neste Connector.'
        : 'Spoolman acessível.'
    case 'unreachable':
      return 'O Connector não alcançou o Spoolman. Confira a origem, a rede e se o serviço está no ar.'
    case 'unauthorized':
      return 'O Spoolman recusou as credenciais. Confira o usuário, a senha ou o token.'
    default:
      return 'Não foi possível concluir a configuração neste Connector. Nada foi alterado; tente novamente.'
  }
}
export function describeSpoolmanConfigurationError(code: string) {
  switch (code) {
    case 'spoolman-unreachable':
      return describeSpoolmanResult({
        agentId: '',
        status: 'unreachable',
        configured: false,
      })
    case 'spoolman-unauthorized':
      return describeSpoolmanResult({
        agentId: '',
        status: 'unauthorized',
        configured: false,
      })
    default:
      return null
  }
}

/** The slice of the browser session the Spoolman flow needs. */
export interface SpoolmanSession {
  advertisedRevision: number
  prepare(input: {
    operationId: string
    target: SpoolmanConfigurationTarget
    expectedRevision: number
    signal: AbortSignal
  }): Promise<SpoolmanOutcome>
  commit(input: {
    operationId: string
    target: SpoolmanConfigurationTarget
    targetSha256: string
    preparedReceiptSha256: string
    expectedRevision: number
    signal: AbortSignal
    completeInventory: false
  }): Promise<SpoolmanOutcome>
  cancel(input: {
    operationId: string
    target: SpoolmanConfigurationTarget
    targetSha256: string
    expectedRevision: number
    signal: AbortSignal
  }): Promise<unknown>
  close(): void
}
export type SpoolmanOutcome =
  | { kind: 'prepared'; targetSha256: string; receiptSha256: string }
  | { kind: 'local-committed' }
  | { kind: 'error'; code: string }
  | { kind: string }
type SpoolmanConfigurationTarget = ReturnType<typeof SpoolmanTargetSchema.parse>

/**
 * Pushes one farm Spoolman to every selected Connector through config-v1:
 * prepare runs the connection test on the Connector, commit stores it there.
 * The credentials travel only inside the session; `report` receives the
 * non-secret outcome (origin and status) for the server to remember.
 */
export async function configureSpoolmanOnConnectors(input: {
  target: SpoolmanConfigurationTarget
  agentIds: readonly string[]
  openSession: (
    agentId: string,
    signal: AbortSignal,
  ) => Promise<SpoolmanSession>
  report: (result: {
    agentId: string
    origin: string
    serviceId?: string
    status: SpoolmanStatus
    configured: boolean
  }) => Promise<void>
  signal: AbortSignal
  onResult?: (result: SpoolmanConnectorResult) => void
}): Promise<SpoolmanConnectorResult[]> {
  const origin = new URL(input.target.origin).origin
  const results: SpoolmanConnectorResult[] = []
  const done = (result: SpoolmanConnectorResult) => {
    results.push(result)
    input.onResult?.(result)
  }
  for (const agentId of input.agentIds) {
    if (input.signal.aborted) break
    let session: SpoolmanSession | undefined
    let commitStarted = false
    try {
      session = await input.openSession(agentId, input.signal)
      const operationId = crypto.randomUUID()
      const expectedRevision = session.advertisedRevision
      const prepared = await session.prepare({
        operationId,
        target: input.target,
        expectedRevision,
        signal: input.signal,
      })
      if (prepared.kind === 'error') {
        const code = (prepared as { code: string }).code
        const status: SpoolmanStatus | null =
          code === 'spoolman-unreachable'
            ? 'unreachable'
            : code === 'spoolman-unauthorized'
              ? 'unauthorized'
              : null
        if (!status) {
          done({ agentId, status: 'failed', configured: false })
          continue
        }
        await input
          .report({ agentId, origin, status, configured: false })
          .catch(() => {})
        done({ agentId, status, configured: false })
        continue
      }
      if (prepared.kind !== 'prepared') {
        done({ agentId, status: 'failed', configured: false })
        continue
      }
      const ready = prepared as Extract<SpoolmanOutcome, { kind: 'prepared' }>
      commitStarted = true
      const committed = await session.commit({
        operationId,
        target: input.target,
        targetSha256: ready.targetSha256,
        preparedReceiptSha256: ready.receiptSha256,
        expectedRevision,
        signal: input.signal,
        completeInventory: false,
      })
      if (committed.kind !== 'local-committed') {
        // Nothing was committed; drop the staged credentials on the Connector.
        await session
          .cancel({
            operationId,
            target: input.target,
            targetSha256: ready.targetSha256,
            expectedRevision,
            signal: input.signal,
          })
          .catch(() => {})
        done({ agentId, status: 'failed', configured: false })
        continue
      }
      await input
        .report({
          agentId,
          origin,
          status: 'reachable',
          configured: true,
          ...(input.target.service_id
            ? { serviceId: input.target.service_id }
            : {}),
        })
        .catch(() => {})
      done({ agentId, status: 'reachable', configured: true })
    } catch {
      done({
        agentId,
        status: 'failed',
        configured: false,
        ...(commitStarted ? { outcome: 'unknown' as const } : {}),
      })
    } finally {
      session?.close()
    }
  }
  return results
}
