import { parseOffer } from '../../../../packages/farm-protocol/src/file-transfer.ts'
import type { FileListResult } from '../../../../packages/farm-protocol/src/file-list.ts'
import type { FarmPauseControl } from './webrtc/farm-pause-control.ts'
import {
  printableFile,
  printOutcomeText,
  validateUpload,
} from './files-view.ts'

export type FilesState =
  | { kind: 'idle' }
  | { kind: 'loading' | 'preparing' | 'starting' }
  | { kind: 'uploading'; sent: number; total: number }
  | { kind: 'done' | 'error' | 'cancelled'; message: string }
type Session = Pick<
  FarmPauseControl,
  'listFiles' | 'sendFile' | 'issueControlCommand' | 'close' | 'dispose'
>
export type PrinterFile = Extract<FileListResult, { ok: true }>['files'][number]

/** Each operation gets a fresh single-use control session. */
export function createFilesSession(input: {
  connect(signal: AbortSignal): Promise<Session>
  available(): boolean
  changed(state: FilesState): void
  files(files: PrinterFile[]): void
  /** The printer library cannot list files; a stored name may be typed. */
  listUnsupported?(): void
}) {
  let printRefs = new Map<string, string>()
  let active: AbortController | undefined
  async function run(
    work: (
      session: Session,
      signal: AbortSignal,
      publish: (state: FilesState) => void,
    ) => Promise<void>,
  ) {
    if (active || !input.available()) return
    const controller = new AbortController()
    active = controller
    let session: Session | undefined
    const publish = (state: FilesState) => {
      if (!controller.signal.aborted && active === controller)
        input.changed(state)
    }
    publish({ kind: 'loading' })
    try {
      session = await input.connect(controller.signal)
      controller.signal.addEventListener('abort', () => session?.close(), {
        once: true,
      })
      controller.signal.throwIfAborted()
      if (!input.available()) throw Error('Unavailable')
      await work(session, controller.signal, publish)
    } catch {
      publish({
        kind: 'error',
        message:
          'Não foi possível concluir pela conexão direta. Verifique a impressora antes de tentar novamente.',
      })
    } finally {
      controller.abort()
      session?.close()
      await session?.dispose()
      if (active === controller) active = undefined
    }
  }
  return {
    list(printerKey: string) {
      return run(async (session, signal, publish) => {
        const result = await session.listFiles(printerKey)
        signal.throwIfAborted()
        if (!result.ok) {
          if (result.reason === 'unsupported') {
            input.files([])
            printRefs.clear()
            input.listUnsupported?.()
            publish({
              kind: 'error',
              message:
                'Listagem não suportada pela biblioteca desta impressora.',
            })
            return
          }
          throw Error('File list rejected')
        }
        printRefs = new Map(
          result.files.flatMap((file) =>
            file.printRef ? [[file.name, file.printRef]] : [],
          ),
        )
        input.files(result.files)
        publish({
          kind: 'done',
          message: result.files.length
            ? 'Arquivos atualizados.'
            : 'Nenhum arquivo nesta impressora.',
        })
      })
    },
    upload(printerKey: string, file: File) {
      const error = validateUpload(file)
      if (active) return Promise.resolve()
      if (error) {
        input.changed({ kind: 'error', message: error })
        return Promise.resolve()
      }
      return run(async (session, signal, publish) => {
        publish({ kind: 'preparing' })
        const digest = await crypto.subtle.digest(
          'SHA-256',
          await file.arrayBuffer(),
        )
        signal.throwIfAborted()
        if (!input.available()) throw Error('Unavailable')
        const sha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')
        const offer = parseOffer({
          type: 'offer',
          transfer_id: crypto.randomUUID(),
          printer_key: printerKey,
          name: file.name,
          size: file.size,
          sha256,
        })
        publish({ kind: 'uploading', sent: 0, total: file.size })
        const result = await session.sendFile(offer, file, signal, (sent) =>
          publish({ kind: 'uploading', sent, total: file.size }),
        )
        signal.throwIfAborted()
        if (!result.ok) {
          if (result.reason === 'unsupported') {
            publish({
              kind: 'error',
              message: 'Envio não suportado pela biblioteca desta impressora.',
            })
            return
          }
          throw Error('Upload rejected')
        }
        if (result.library) {
          input.files([])
          printRefs.clear()
          publish({
            kind: 'done',
            message:
              'Arquivo enviado à biblioteca da ponte. Atualize a lista para selecionar e iniciar a impressão.',
          })
          return
        }
        printRefs.clear()
        input.files([{ name: file.name, size: file.size, modified: 0 }])
        publish({
          kind: 'done',
          message:
            'Arquivo enviado. Selecione-o e confirme para iniciar a impressão.',
        })
      })
    },
    start(name: string) {
      if (!printableFile(name)) return Promise.resolve()
      return run(async (session, signal, publish) => {
        signal.throwIfAborted()
        if (!input.available()) throw Error('Unavailable')
        publish({ kind: 'starting' })
        const outcome = await session.issueControlCommand('start_print', {
          file: printRefs.get(name) ?? name,
        })
        publish({ kind: 'done', message: printOutcomeText(outcome) })
      })
    },
    cancel() {
      if (!active) return
      active.abort()
      input.changed({
        kind: 'cancelled',
        message:
          'Operação cancelada neste navegador. Confira o estado da impressora e seus arquivos antes de tentar novamente.',
      })
    },
  }
}
