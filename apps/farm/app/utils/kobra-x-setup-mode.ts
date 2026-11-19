// New Kobra X setup uses the native Connector adapter by default. The KobraLink
// bridge stays available only as an explicit legacy choice; existing bridge
// assignments and pending bridge operations never go through this choice.
export type KobraXSetupChoice = 'native' | 'kobralink-bridge'

export const DEFAULT_KOBRA_X_SETUP_MODE: KobraXSetupChoice = 'native'

export const KOBRA_X_NATIVE_CHOICE_LABEL = 'Conexão nativa Kobra X (padrão)'
export const KOBRA_X_NATIVE_CHOICE_HELP =
  'O Connector fala direto com a impressora pela LAN (HTTP 18910 e MQTT com certificado de cliente), sem Docker e sem ponte. Descobrir a impressora ou validar o certificado não comprova conexão: a atribuição só vale depois que o Connector confirmar o login na impressora.'
export const KOBRA_X_BRIDGE_CHOICE_LABEL = 'Usar ponte KobraLink (legado)'
export const KOBRA_X_BRIDGE_CHOICE_HELP =
  'Caminho legado: exige a ponte KobraLink do Connector (Docker). Escolha somente para manter o comportamento anterior. Descobrir a impressora ou validar o certificado não comprova conexão: a atribuição só vale depois da confirmação do Connector.'
export const KOBRA_X_MODE_INVALID_MESSAGE =
  'Escolha a conexão nativa ou a ponte KobraLink (legado) para preparar a Kobra X.'

export type KobraXSetupGate =
  | { readonly ok: true; readonly mode: KobraXSetupChoice }
  | { readonly ok: false; readonly error: string }

// Anything but a known choice fails closed before any validation or dispatch.
export function gateKobraXSetup(request: unknown): KobraXSetupGate {
  return request === 'native' || request === 'kobralink-bridge'
    ? { ok: true, mode: request }
    : { ok: false, error: KOBRA_X_MODE_INVALID_MESSAGE }
}
