import {
  withoutKobraClientCertificate,
  type ConfigurationTarget,
  type KobraClientCertificateInput,
} from '../../../../packages/farm-protocol/src/configuration-target.ts'
import {
  validateKobraClientCertificate,
  type KobraClientCertErrorReason,
  type KobraClientCertMetadata,
} from '../../../../packages/farm-protocol/src/kobra-client-cert.ts'

export type KobraCertSourceMode = 'file' | 'install-path'

export type KobraCertUiSummary = {
  subject: string
  commonName: string | null
  notAfterIso: string
  format: 'pem' | 'pkcs12'
}

export type KobraCertCachedFile = {
  name: string
  bytes: Uint8Array
}

export const ANYCUBIC_SLICER_NEXT_PATH_HINTS = Object.freeze([
  'macOS: /Applications/AnycubicSlicerNext.app/Contents/Resources',
  'Windows: C:\\Program Files\\AnycubicSlicerNext\\resources (ou %LOCALAPPDATA%\\AnycubicSlicerNext)',
  'Linux: /opt/AnycubicSlicerNext/resources (ou pasta extraída da AppImage / ~/.local/share/AnycubicSlicerNext)',
])

const MAX_CERT_IMPORT_BYTES = 128 * 1024
const PEM_BEGIN_MARK = ['-----', 'BEGIN '].join('')

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function formatKobraCertError(
  reason: KobraClientCertErrorReason,
  detail?: string,
  metadata?: Partial<KobraClientCertMetadata>,
): string {
  switch (reason) {
    case 'missing':
      return 'Certificado do cliente ausente (client certificate missing): importe um arquivo PEM/PKCS#12 ou informe o caminho do Anycubic Slicer Next.'
    case 'unreadable':
      return (
        detail ||
        'Certificado ou chave ilegível (unreadable): confira se o arquivo PEM/PKCS#12 está completo e se a senha está correta.'
      )
    case 'wrong-subject':
      return `Subject do certificado inválido (wrong subject: ${metadata?.subject ?? 'desconhecido'}): esperado CN=AnycubicSlicer.`
    case 'expired':
      return `Certificado expirado ou fora da janela de validade (expired: ${metadata?.notAfterIso ?? 'data inválida'}).`
  }
}

export async function processSelectedKobraCertFiles(input: {
  files: readonly KobraCertCachedFile[]
  passphrase?: string
  now?: number
}): Promise<
  | {
      ok: true
      summary: KobraCertUiSummary
      payload: KobraClientCertificateInput
      fileLabel: string
    }
  | {
      ok: false
      reason: KobraClientCertErrorReason
      error: string
      summary: KobraCertUiSummary | null
    }
> {
  if (!input.files.length) {
    return {
      ok: false,
      reason: 'missing',
      error: formatKobraCertError('missing'),
      summary: null,
    }
  }
  if (input.files.some((f) => f.bytes.byteLength === 0)) {
    return {
      ok: false,
      reason: 'unreadable',
      error: formatKobraCertError(
        'unreadable',
        'Arquivo de certificado vazio ou ilegível (unreadable).',
      ),
      summary: null,
    }
  }
  if (input.files.some((f) => f.bytes.byteLength > MAX_CERT_IMPORT_BYTES)) {
    return {
      ok: false,
      reason: 'unreadable',
      error: formatKobraCertError(
        'unreadable',
        'Arquivo excede o tamanho máximo suportado de 128 KB (unreadable).',
      ),
      summary: null,
    }
  }

  const fileLabel = input.files.map((f) => f.name).join(', ')
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const texts = input.files.map((f) => decoder.decode(f.bytes))
  const isPemInput =
    input.files.length > 1 ||
    texts.some((t) => t.includes(PEM_BEGIN_MARK)) ||
    input.files.every((f) => /\.(pem|crt|cer|key)$/i.test(f.name))

  const result = isPemInput
    ? await validateKobraClientCertificate({
        text: texts.join('\n'),
        passphrase: input.passphrase,
        now: input.now,
      })
    : await validateKobraClientCertificate({
        bytes: input.files[0]!.bytes,
        passphrase: input.passphrase,
        now: input.now,
      })

  const summary: KobraCertUiSummary | null = result.metadata
    ? {
        subject: result.metadata.subject ?? '',
        commonName: result.metadata.commonName ?? null,
        notAfterIso: result.metadata.notAfterIso ?? '',
        format: isPemInput ? 'pem' : 'pkcs12',
      }
    : null

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      error: formatKobraCertError(
        result.reason,
        result.message,
        result.metadata,
      ),
      summary,
    }
  }

  const payload: KobraClientCertificateInput =
    result.format === 'pem'
      ? {
          kind: 'inline',
          format: 'pem',
          certificate_pem: result.certificatePem,
          key_pem: result.keyPem,
        }
      : {
          kind: 'inline',
          format: 'pkcs12',
          pkcs12_base64: bytesToBase64(input.files[0]!.bytes),
          ...(input.passphrase ? { passphrase: input.passphrase } : {}),
        }

  return {
    ok: true,
    summary: {
      subject: result.metadata.subject,
      commonName: result.metadata.commonName,
      notAfterIso: result.metadata.notAfterIso,
      format: result.format,
    },
    payload,
    fileLabel,
  }
}

export function buildKobraCertTargetOption(input: {
  source: KobraCertSourceMode
  installPath: string
  inlinePayload: KobraClientCertificateInput | null
  certError: string
}):
  | { ok: true; clientCertificate: KobraClientCertificateInput }
  | { ok: false; error: string } {
  if (input.source === 'install-path') {
    const trimmed = input.installPath.trim()
    if (!trimmed) {
      return {
        ok: false,
        error:
          'Informe o caminho da instalação do Anycubic Slicer Next no host do Connector (client certificate missing).',
      }
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed) || trimmed.length > 1024) {
      return {
        ok: false,
        error:
          'Caminho de instalação do Anycubic Slicer Next inválido (unreadable path).',
      }
    }
    return {
      ok: true,
      clientCertificate: {
        kind: 'install-path',
        path: trimmed,
      },
    }
  }

  if (input.certError) {
    return { ok: false, error: input.certError }
  }
  if (!input.inlinePayload) {
    return { ok: false, error: formatKobraCertError('missing') }
  }
  return { ok: true, clientCertificate: input.inlinePayload }
}

export function sanitizeTargetForClientStorage(
  target: ConfigurationTarget,
): ConfigurationTarget {
  return target.backend === 'kobralink-anycubic' || target.backend === 'kobra-x'
    ? withoutKobraClientCertificate(target)
    : target
}
