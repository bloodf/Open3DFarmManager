// New Kobra X setup must name its transport. Only the KobraLink bridge can be
// prepared today; the native adapter is partial and has no activation path.
export type KobraXSetupChoice = 'unselected' | 'kobralink-bridge'

export type KobraXSetupRequest = KobraXSetupChoice | 'native'

export const KOBRA_X_BRIDGE_CHOICE_LABEL = 'Usar ponte KobraLink'
export const KOBRA_X_NATIVE_CHOICE_LABEL = 'Conexão nativa Kobra X'
export const KOBRA_X_BRIDGE_CHOICE_HELP =
  'A ponte KobraLink do Connector é o único caminho disponível para preparar uma Kobra X. Descobrir a impressora ou validar o certificado não comprova conexão: a atribuição só vale depois da confirmação do Connector.'
export const KOBRA_X_NATIVE_UNAVAILABLE_REASON =
  'A ativação nativa está indisponível: o adaptador nativo ainda é parcial e não foi validado em uma impressora real. Use a ponte KobraLink.'
export const KOBRA_X_BRIDGE_REQUIRED_MESSAGE =
  'Escolha “Usar ponte KobraLink” para preparar a Kobra X. A conexão nativa está indisponível.'

export type KobraXSetupGate =
  | { readonly ok: true; readonly mode: 'kobralink-bridge' }
  | { readonly ok: false; readonly error: string }

export function gateKobraXSetup(request: KobraXSetupRequest): KobraXSetupGate {
  switch (request) {
    case 'kobralink-bridge':
      return { ok: true, mode: 'kobralink-bridge' }
    case 'native':
      return { ok: false, error: KOBRA_X_NATIVE_UNAVAILABLE_REASON }
    case 'unselected':
      return { ok: false, error: KOBRA_X_BRIDGE_REQUIRED_MESSAGE }
    default: {
      const _exhaustive: never = request
      return _exhaustive
    }
  }
}
