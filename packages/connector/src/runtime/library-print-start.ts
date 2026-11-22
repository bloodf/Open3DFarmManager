import { open } from 'node:fs/promises'
import { get } from 'node:https'
import {
  checkCompatibility,
  type CompatibilityMetadata,
  type CompatibilityProfile,
  type LoadedMaterial,
} from '../../../shared/src/print-file/compatibility.ts'
import { readThreeMf } from '../../../shared/src/print-file/3mf-meta.ts'
import {
  readLibraryGcodeMetadata,
  type PrintFileMetadata,
} from '../../../shared/src/print-file/metadata.ts'
import type { ZipSource } from '../../../shared/src/print-file/zip.ts'
import {
  LibraryPrintArgs,
  type ExtendedControlAction,
} from '../../../farm-protocol/src/control-actions.ts'
import type {
  PauseDriver,
  PreparedPauseDriver,
} from '../control/pause-dispatcher.ts'
import type { LibraryJobStart } from './library-job-links.ts'
import type { PrinterBinding } from '../control/printer-binding.ts'
import type { LibraryStore } from './library-store.ts'
import { LibraryStoreError } from './library-store.ts'
import {
  LibraryCacheError,
  type LibraryCache,
  type LibraryDownload,
  type LibraryDownloader,
} from './library-cache.ts'
import {
  supportsFileUpload,
  uploadFile,
  type FileUploadTarget,
} from './file-upload.ts'

/**
 * `start_library_print` on the Connector (#384). The file comes from the
 * Connector's own library store (Connector mode) or from the bounded cache
 * filled from the server (server mode); either way its hash is verified, its
 * metadata is checked against this printer's own observed profile, and only
 * then the file is uploaded and the existing `start_print` path runs once.
 * Nothing here retries: a failure after `start` was called propagates as is.
 */
export type LibraryPrintRefusal =
  | 'incompatible'
  | 'download-failed'
  | 'checksum-mismatch'
  | 'cache-full'
  | 'local-file-missing'
  | 'unsupported'

/** Accessible pt-BR text for each refusal. */
export const LIBRARY_PRINT_MESSAGES: Record<LibraryPrintRefusal, string> = {
  incompatible: 'O arquivo é incompatível com esta impressora.',
  'download-failed':
    'Não foi possível baixar o arquivo da biblioteca do servidor.',
  'checksum-mismatch':
    'O arquivo não confere com o SHA-256 registrado e não será impresso.',
  'cache-full':
    'O cache do Conector está cheio e não há espaço para este arquivo.',
  'local-file-missing':
    'O arquivo não está na biblioteca do Conector. Envie o arquivo novamente.',
  unsupported: 'Esta impressora não aceita impressão pela biblioteca.',
}

export type LibraryPrintResult =
  | { ok: true; source: 'cache' | 'download' | 'local'; name: string }
  | {
      ok: false
      code: LibraryPrintRefusal
      message: string
      /** Compatibility findings, when the refusal is `incompatible`. */
      reasons?: readonly string[]
    }

export type LibraryPrintStart = (
  name: string,
  extra: { plate?: number; ams_mapping?: number[] },
) => Promise<void>

const refuse = (
  code: LibraryPrintRefusal,
  reasons?: readonly string[],
): LibraryPrintResult => ({
  ok: false,
  code,
  message: LIBRARY_PRINT_MESSAGES[code],
  ...(reasons ? { reasons } : {}),
})

/** Metadata is read from a file the Connector already verified. */
async function readMetadata(
  path: string,
  kind: 'gcode' | '3mf',
  plate: number,
): Promise<
  { ok: true; meta: CompatibilityMetadata } | { ok: false; reasons: string[] }
> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const source: ZipSource = {
      size,
      async read(offset, length) {
        const buffer = Buffer.alloc(Math.min(length, size - offset))
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        )
        return buffer.subarray(0, bytesRead)
      },
    }
    if (kind === 'gcode')
      return {
        ok: true,
        meta: { ...(await readLibraryGcodeMetadata(source)), format: 'gcode' },
      }
    const result = await readThreeMf(source)
    if (!result.ok) return { ok: false, reasons: [result.reason] }
    const { project } = result
    const chosen = project.plates.find((entry) => entry.index === plate)
    if (!chosen?.startable)
      return {
        ok: false,
        reasons: [`A placa ${plate} não existe ou não foi fatiada.`],
      }
    const nozzle = project.nozzleDiameter ?? chosen.nozzleDiameter
    const tools = project.filaments.map((filament) => ({
      ...(nozzle === undefined ? {} : { nozzleDiameter: nozzle }),
      ...(filament.type ? { filamentType: filament.type } : {}),
      ...(filament.colour ? { filamentColour: filament.colour } : {}),
    }))
    const base: PrintFileMetadata = {
      ...chosen.gcode,
      ...(project.printerModel ? { printerModel: project.printerModel } : {}),
      ...(tools.length
        ? { tools }
        : nozzle === undefined
          ? {}
          : { tools: [{ nozzleDiameter: nozzle }] }),
    }
    return {
      ok: true,
      meta: { ...base, format: '3mf', sliced: project.sliced },
    }
  } finally {
    await handle.close()
  }
}

const ZIP_MAGIC = 'PK\x03\x04'
async function sniffKind(path: string): Promise<'gcode' | '3mf'> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(4)
    await handle.read(head, 0, 4, 0)
    return head.toString('latin1') === ZIP_MAGIC ? '3mf' : 'gcode'
  } finally {
    await handle.close()
  }
}

const plainName = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  !/[\\/\x00-\x1f\x7f]/.test(name) &&
  !name.includes('..')

export function createLibraryPrintStarter(config: {
  /** Server-mode cache; the file is fetched by hash only. */
  cache: LibraryCache
  download: LibraryDownloader
  /** Connector-mode library on this host. Its index tells where a hash lives. */
  local?: Pick<LibraryStore, 'has' | 'list' | 'openForPrint'>
  /** This printer's own observed profile; never taken from the action. */
  profile(): Promise<CompatibilityProfile | undefined>
  materials?(): readonly (LoadedMaterial | undefined)[]
  /** Test seam; defaults to the shared upload targets. */
  upload?: typeof uploadFile
}) {
  const upload = config.upload ?? uploadFile

  /** A hash the local index knows is Connector-mode: the server holds no copy. */
  async function resolveLocal(sha256: string) {
    const entries = (await config.local?.list()) ?? []
    const known = entries.filter((entry) => entry.sha256 === sha256)
    if (known.length)
      return known.find((entry) => entry.state === 'stored') ?? known[0]!
    // A Connector-mode upload relayed by the server stores the bytes before
    // any version is linked: the verified file alone makes the hash local.
    return (await config.local?.has(sha256))
      ? { state: 'stored' as const, kind: undefined, name: undefined }
      : null
  }

  return {
    async start(input: {
      args: LibraryPrintArgs
      target: FileUploadTarget
      signal: AbortSignal
      authorize(): boolean
      start: LibraryPrintStart
    }): Promise<LibraryPrintResult> {
      const { args, target, signal } = input
      const bambu = target.backend === 'bambu'
      if (!bambu && (args.plate !== undefined || args.ams_mapping))
        return refuse('incompatible', [
          'Placa e mapeamento do AMS valem só para impressoras Bambu.',
        ])
      const requireAuthorization = () => {
        if (!input.authorize())
          throw Object.assign(new Error('unauthorized'), {
            refusal: 'state',
          })
      }
      requireAuthorization()

      let release = () => {}
      try {
        let path: string
        let source: 'cache' | 'download' | 'local'
        let name: string
        let kind: 'gcode' | '3mf'
        const local = await resolveLocal(args.sha256)
        if (local) {
          if (local.state !== 'stored') return refuse('local-file-missing')
          try {
            path = (await config.local!.openForPrint(args.sha256)).path
          } catch (error) {
            if (error instanceof LibraryStoreError)
              return refuse(
                error.code === 'hash-mismatch'
                  ? 'checksum-mismatch'
                  : 'local-file-missing',
              )
            throw error
          }
          source = 'local'
          kind = local.kind ?? (await sniffKind(path))
          name =
            local.name !== undefined &&
            plainName(local.name) &&
            local.name.toLowerCase().endsWith(`.${kind}`)
              ? local.name
              : `${args.sha256.slice(0, 16)}.${kind}`
        } else {
          try {
            const cached = await config.cache.acquire(
              args.sha256,
              config.download,
              signal,
            )
            release = cached.release
            path = cached.path
            source = cached.reused ? 'cache' : 'download'
          } catch (error) {
            if (error instanceof LibraryCacheError) return refuse(error.code)
            throw error
          }
          kind = await sniffKind(path)
          name = `${args.sha256.slice(0, 16)}.${kind}`
        }
        // A .3mf project only prints on Bambu; every other backend takes G-code.
        if (kind === '3mf' && !bambu)
          return refuse('incompatible', [
            'Arquivos 3MF só podem ser impressos em impressoras Bambu.',
          ])
        if (!supportsFileUpload(target, name)) return refuse('unsupported')

        const profile = await config.profile()
        if (!profile)
          return refuse('incompatible', [
            'O perfil da impressora não está disponível.',
          ])
        const read = await readMetadata(path, kind, args.plate ?? 1)
        if (!read.ok) return refuse('incompatible', read.reasons)
        const verdict = checkCompatibility(
          read.meta,
          profile,
          config.materials?.() ?? [],
        )
        if (verdict.level === 'block')
          return refuse(
            'incompatible',
            verdict.reasons
              .filter((reason) => reason.level === 'block')
              .map((reason) => reason.message),
          )

        // Same order as a job delivery: authorize, upload, authorize, start once.
        requireAuthorization()
        await upload({
          target,
          filePath: path,
          name,
          signal,
          authorize: input.authorize,
        })
        signal.throwIfAborted()
        requireAuthorization()
        await input.start(name, {
          ...(args.plate === undefined ? {} : { plate: args.plate }),
          ...(args.ams_mapping ? { ams_mapping: [...args.ams_mapping] } : {}),
        })
        return { ok: true, source, name }
      } finally {
        release()
      }
    },
  }
}

type ExecuteRequest = Parameters<NonNullable<PauseDriver['execute']>>[2]

/** What a library start printed, so the finished job links to it (#385). */
export type LibraryPrintLink = LibraryJobStart

/** A refusal the dispatcher records as not sent: nothing reached the printer. */
function driverRefusal(result: Extract<LibraryPrintResult, { ok: false }>) {
  return Object.assign(new Error(result.message), {
    refusal:
      result.code === 'unsupported'
        ? 'unsupported-action'
        : result.code === 'incompatible' || result.code === 'checksum-mismatch'
          ? 'invalid-command'
          : 'state',
    ...(result.code === 'unsupported' ? {} : { resultCode: result.code }),
  })
}

/**
 * `start_library_print` on the browser's signed control path (#386). The
 * dispatcher keeps every rule it applies to any signed command (capability,
 * role, replay and busy journal, fresh printer state, one send, no retry);
 * this wrapper adds the library steps of the API path in between: the hash
 * check, the server-mode cache or the Connector-mode local copy, the
 * compatibility check and the upload. The single send is the driver's own
 * `start_print`, guarded by the dispatcher's `beforeSend`.
 */
export function withLibraryPrint<D extends PreparedPauseDriver>(
  driver: D,
  config: {
    starter: ReturnType<typeof createLibraryPrintStarter> | undefined
    /** Upload target of the locally provisioned printer behind a binding. */
    targetFor(binding: PrinterBinding): FileUploadTarget | undefined
    remember?(
      binding: PrinterBinding,
      link: LibraryPrintLink,
      sentAt: number,
    ): void
  },
): D {
  const { starter } = config
  const execute = driver.execute?.bind(driver)
  if (!starter || !execute) return driver
  const controls = (binding: PrinterBinding) =>
    driver.controls?.(binding) ?? (['pause'] as const)
  /** File each binding's current attempt started; its effect must name it. */
  const started = new WeakMap<PrinterBinding, string>()
  return Object.freeze({
    ...driver,
    controls(binding: PrinterBinding): readonly ExtendedControlAction[] {
      const base = controls(binding)
      return base.includes('start_print') &&
        !base.includes('start_library_print') &&
        config.targetFor(binding)
        ? Object.freeze([...base, 'start_library_print' as const])
        : base
    },
    async execute(
      action: ExtendedControlAction,
      args: Record<string, unknown>,
      request: ExecuteRequest,
    ) {
      if (action !== 'start_library_print')
        return execute(action, args, request)
      const { binding, signal } = request
      started.delete(binding)
      const parsed = LibraryPrintArgs.safeParse(args)
      if (!parsed.success)
        throw Object.assign(new Error('Invalid library print'), {
          refusal: 'invalid-command',
        })
      const target = config.targetFor(binding)
      if (!target || !controls(binding).includes('start_print'))
        throw Object.assign(new Error('Library print unavailable'), {
          refusal: 'unsupported-action',
        })
      let rpc: Awaited<ReturnType<typeof execute>> | undefined
      const outcome = await starter.start({
        args: parsed.data,
        target,
        signal,
        // Capability, role and printer state are re-read at every step.
        authorize: () =>
          !signal.aborted && request.stillAuthorized?.() === true,
        async start(name, extra) {
          started.set(binding, name)
          rpc = await execute(
            'start_print',
            { file: name, ...extra },
            {
              ...request,
              beforeSend() {
                if (!request.beforeSend()) return false
                config.remember?.(
                  binding,
                  {
                    name,
                    sha256: parsed.data.sha256,
                    ...(parsed.data.plate === undefined
                      ? {}
                      : { plate: parsed.data.plate }),
                  },
                  Date.now(),
                )
                return true
              },
            },
          )
        },
      })
      if (!outcome.ok) throw driverRefusal(outcome)
      return rpc!
    },
    async waitForPaused(
      input: Parameters<PreparedPauseDriver['waitForPaused']>[0],
    ) {
      if (input.action !== ('start_library_print' as string))
        return driver.waitForPaused(input)
      const name = started.get(input.binding)
      if (!name) return null
      const observation = await driver.waitForPaused({
        ...input,
        action: 'start_print' as never,
        args: { file: name },
      })
      // Only the file this attempt uploaded confirms the start.
      return observation?.effect?.kind === 'file' &&
        observation.effect.filename === name
        ? observation
        : null
    },
  }) as D
}

/**
 * Production downloader for `GET {baseUrl}/api/connector/library/{sha256}`
 * (E17.11). HTTPS only, no redirects, so the credential headers never leave
 * the configured server. `headers` supplies the Connector credential proof.
 */
export function createHttpsLibraryDownloader(config: {
  baseUrl: string
  headers(): Promise<Record<string, string>> | Record<string, string>
  ca?: string | Buffer
}): LibraryDownloader {
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password)
    throw new Error('Invalid library server URL')
  return async (sha256, signal) => {
    const url = new URL(`/api/connector/library/${sha256}`, base)
    const headers = await config.headers()
    const response = await new Promise<import('node:http').IncomingMessage>(
      (resolve, reject) => {
        const request = get(
          url,
          { signal, headers, ...(config.ca ? { ca: config.ca } : {}) },
          resolve,
        )
        request.on('error', reject)
      },
    )
    if (response.statusCode !== 200) {
      response.destroy()
      throw new Error('download-failed')
    }
    const length = Number(response.headers['content-length'])
    const download: LibraryDownload = {
      stream: response,
      ...(Number.isSafeInteger(length) && length >= 0 ? { size: length } : {}),
    }
    return download
  }
}
