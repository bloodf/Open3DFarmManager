import {
  AnycubicConfigurationTarget,
  type AnycubicConfigurationTarget as Target,
} from '../../../../packages/farm-protocol/src/configuration-target.ts'

export function withoutAnycubicCredentials(target: Target) {
  const { username: _username, password: _password, ...safe } = target
  return safe
}
export function validateAnycubicTargetInput(input: {
  host: string
  port?: number
  modelId: string
  deviceId: string
  caFile?: string | undefined
  pinSha256?: string | undefined
  username: string
  password: string
  displayLabel?: string
}) {
  const parsed = AnycubicConfigurationTarget.safeParse({
    v: 1,
    protocol: 'config-v1',
    backend: 'anycubic',
    model: { family: 'anycubic-lan', provisional: true },
    host: input.host,
    port: input.port ?? 9883,
    modelId: input.modelId,
    deviceId: input.deviceId,
    ...(input.caFile ? { caFile: input.caFile } : {}),
    ...(input.pinSha256 ? { pinSha256: input.pinSha256 } : {}),
    username: input.username,
    password: input.password,
  })
  if (!parsed.success || !input.username || !input.password)
    return {
      ok: false,
      error:
        'Informe IPv4, porta, modelo, identidade e credenciais LAN válidos.',
    } as const
  const displayLabel = (input.displayLabel ?? '').trim()
  if (displayLabel.length > 64 || /[\p{Cc}]/u.test(displayLabel))
    return {
      ok: false,
      error: 'O apelido deve ter até 64 caracteres visíveis.',
    } as const
  return { ok: true, target: parsed.data, displayLabel } as const
}
export function describeAnycubicConfigurationError(code: string) {
  switch (code) {
    case 'not-available':
      return 'Anycubic inacessível. Confira as credenciais LAN e a configuração privada do Connector.'
    case 'invalid-request':
      return 'Informe um endereço em uma rede local autorizada no Connector e credenciais LAN válidas.'
    case 'identity-conflict':
      return 'Esta Anycubic já possui uma atribuição diferente. Nada foi alterado.'
    default:
      return null
  }
}

/** Browser DTO: credentials never leave Connector custody after preparation. */
export function describeAnycubicTarget(
  target: Pick<Target, 'host' | 'port' | 'modelId' | 'deviceId'>,
) {
  return {
    family: 'Anycubic (LAN)',
    host: target.host,
    port: target.port,
    modelId: target.modelId,
    deviceId: target.deviceId,
    credentials: 'configurado',
    support: 'unqualified',
  } as const
}
