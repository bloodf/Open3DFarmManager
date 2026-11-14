import { MoonrakerConfigurationTarget } from '../../../../packages/farm-protocol/src/configuration-target.ts'

/** Pure form validation. Errors never include the submitted URL or key. */
export function validateMoonrakerTargetInput(input: {
  origin: string
  apiKey?: string
  displayLabel?: string
}) {
  const parsed = MoonrakerConfigurationTarget.safeParse({
    v: 1,
    protocol: 'config-v1',
    backend: 'moonraker',
    model: { family: 'klipper-moonraker', provisional: true },
    origin: input.origin,
    ...(input.apiKey ? { api_key: input.apiKey } : {}),
  })
  if (!parsed.success)
    return {
      ok: false,
      error:
        'Informe uma origem HTTP(S), sem credenciais, caminho, consulta ou fragmento. A chave opcional aceita até 256 letras, números, sublinhados ou hífens.',
    } as const
  const displayLabel = (input.displayLabel ?? '').trim()
  if (displayLabel.length > 64 || /[\p{Cc}]/u.test(displayLabel))
    return {
      ok: false,
      error: 'O apelido deve ter até 64 caracteres visíveis.',
    } as const
  return {
    ok: true,
    target: { ...parsed.data, origin: new URL(parsed.data.origin).origin },
    displayLabel,
  } as const
}

export function withoutMoonrakerKey<
  T extends { backend: string; api_key?: string | undefined },
>(target: T): Omit<T, 'api_key'> {
  const { api_key: _key, ...safe } = target
  return safe
}
export function describeMoonrakerConfigurationError(code: string) {
  switch (code) {
    case 'moonraker-unavailable':
      return 'Moonraker inacessível ou autenticação recusada. Confira a origem e a chave de API.'
    case 'moonraker-not-ready':
      return 'O Klipper ainda não está pronto. Verifique a conexão com o Moonraker.'
    case 'moonraker-invalid-response':
      return 'O Moonraker retornou uma resposta incompatível. Nenhuma impressora foi ativada.'
    default:
      return null
  }
}
