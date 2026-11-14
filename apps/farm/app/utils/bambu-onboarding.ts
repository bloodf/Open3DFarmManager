import { BambuConfigurationTarget } from '../../../../packages/farm-protocol/src/configuration-target.ts'

export const BAMBU_LAN_COMMAND_NOTE =
  'Comandos só funcionam com a impressora em "Somente LAN" e com o "Modo desenvolvedor" ativado no painel da Bambu Lab. Sem isso o Connector recebe apenas telemetria. Nada passa pela nuvem da Bambu.'
export const BAMBU_SUPPORT_NOTE =
  'Suporte não qualificado. O Connector verifica a impressora em modo somente leitura antes de aceitar.'

/** Pure form validation. Errors never include the submitted address, serial or code. */
export function validateBambuTargetInput(input: {
  ipv4: string
  serial: string
  accessCode: string
  control?: boolean
  displayLabel?: string
}) {
  const parsed = BambuConfigurationTarget.safeParse({
    v: 1,
    protocol: 'config-v1',
    backend: 'bambu',
    model: { family: 'bambu-lan', provisional: true },
    ipv4: input.ipv4,
    serial: input.serial,
    access_code: input.accessCode,
    control: input.control === true,
  })
  if (!parsed.success || !parsed.data.access_code) {
    const field = parsed.success
      ? 'access_code'
      : String(parsed.error.issues[0]?.path[0] ?? '')
    return {
      ok: false,
      error:
        field === 'ipv4'
          ? 'Informe o endereço IPv4 da impressora na LAN (ex.: 192.168.1.60), sem nome de host, porta ou URL.'
          : field === 'serial'
            ? 'Informe o número de série como aparece na impressora: de 10 a 20 letras maiúsculas e números.'
            : 'Informe o código de acesso LAN mostrado na tela da impressora: de 6 a 32 letras e números.',
    } as const
  }
  const displayLabel = (input.displayLabel ?? '').trim()
  if (displayLabel.length > 64 || /[\p{Cc}]/u.test(displayLabel))
    return {
      ok: false,
      error: 'O apelido deve ter até 64 caracteres visíveis.',
    } as const
  return { ok: true, target: parsed.data, displayLabel } as const
}

export function withoutBambuAccessCode<
  T extends { backend: string; access_code?: string | undefined },
>(target: T): Omit<T, 'access_code'> {
  const { access_code: _code, ...safe } = target
  return safe
}

/** Browser view of a Bambu target: the access code is only ever "configurado". */
export function describeBambuTarget(target: {
  ipv4: string
  serial: string
  control: boolean
}) {
  return {
    family: 'Bambu Lab (LAN)',
    ipv4: target.ipv4,
    serial: target.serial,
    accessCode: 'configurado',
    control: target.control
      ? 'Comandos habilitados (opt-in)'
      : 'Somente telemetria',
    support: 'unqualified',
  } as const
}

export function describeBambuConfigurationError(code: string) {
  switch (code) {
    case 'not-available':
      return 'Impressora Bambu Lab inacessível ou código de acesso recusado. Confira o IP, o número de série, o código de acesso e o modo Somente LAN.'
    case 'invalid-request':
      return 'O Connector recusou este endereço: ele precisa estar em uma rede local autorizada na configuração do Connector.'
    case 'identity-conflict':
      return 'Esta impressora Bambu Lab já está configurada neste Connector com outro endereço, código de acesso ou opção de comandos. Nada foi alterado.'
    default:
      return null
  }
}
