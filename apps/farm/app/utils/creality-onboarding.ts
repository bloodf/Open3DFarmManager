import { CrealityConfigurationTarget } from '../../../../packages/farm-protocol/src/configuration-target.ts'

export const CREALITY_SUPPORT_NOTE =
  'Firmware original: telemetria somente leitura, suporte não qualificado. Se a Creality usa Klipper / Moonraker, selecione o formulário Klipper / Moonraker.'

export function validateCrealityTargetInput(input: {
  host: string
  displayLabel?: string
}) {
  const parsed = CrealityConfigurationTarget.safeParse({
    v: 1,
    protocol: 'config-v1',
    backend: 'creality',
    model: { family: 'creality-native', provisional: true },
    host: input.host,
  })
  if (!parsed.success)
    return {
      ok: false,
      error:
        'Informe o endereço IPv4 da Creality na LAN, sem porta, URL ou credenciais.',
    } as const
  const displayLabel = (input.displayLabel ?? '').trim()
  if (displayLabel.length > 64 || /[\p{Cc}]/u.test(displayLabel))
    return {
      ok: false,
      error: 'O apelido deve ter até 64 caracteres visíveis.',
    } as const
  return { ok: true, target: parsed.data, displayLabel } as const
}

export function describeCrealityConfigurationError(code: string) {
  switch (code) {
    case 'not-available':
      return 'Creality inacessível ou sem telemetria válida. Confira o endereço e o firmware original. Para Klipper, use o formulário Moonraker.'
    case 'invalid-request':
      return 'O endereço precisa estar em uma rede local autorizada no Connector.'
    case 'identity-conflict':
      return 'Esta Creality já possui uma atribuição diferente neste Connector. Nada foi alterado.'
    default:
      return null
  }
}
