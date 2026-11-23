import { moonrakerOrigins } from '../config/moonraker.ts'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ANYCUBIC_FILE_MODEL } from '../anycubic/files.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import { readBambuCredentials } from '../bambu/credentials.ts'
import {
  validateMoonrakerInput,
  moonrakerAuthHeaders,
} from '../config/moonraker.ts'
import { moonrakerQueryClient } from './api-query-moonraker.ts'
import {
  readPrinterBinding,
  readBambuPrinterBinding,
  readAnycubicPrinterBinding,
  readCrealityPrinterBinding,
} from '../control/printer-binding.ts'
import { createKobraLinkFilesTarget } from '../kobralink/runtime.ts'
import type { KobraLinkFetch } from '../kobralink/client.ts'
import type { FileListOptions, FileListTarget } from './file-list.ts'
import type { FileUploadOptions, FileUploadTarget } from './file-upload.ts'

type Targets = Readonly<{
  upload: FileUploadTarget
  list: FileListTarget
}>

/**
 * File listing and upload for the single assignment the Connector opted in to
 * control. Targets come from the local runtime configuration only: nothing on
 * the wire selects an endpoint or a credential. A backend whose file path is
 * not wired here has no target, which keeps both operations unavailable.
 */
export function createFileTargets(input: {
  config: AgentRuntimeConfig
  assignmentId: string
  dataDirectory: string
  kobraLinkFetch?: KobraLinkFetch
}): { fileTransfer: FileUploadOptions; fileList: FileListOptions } {
  const { collection, assignments } = input.config
  const controlledKey = assignments.find(
    (entry) => entry.assignment_id === input.assignmentId,
  )?.printer_key
  const targets = (): Targets | undefined => {
    if (controlledKey === undefined) return undefined
    if (collection.version === 1) {
      const handle = input.config.bindingFor(input.assignmentId)
      const binding = handle && readPrinterBinding(handle)
      const printer = collection.printers.find(
        (item) => item.printerKey === controlledKey,
      )
      if (!printer || binding?.printer_key !== controlledKey) return undefined
      const { origin, limits } = validateMoonrakerInput({
        assignment: printer,
        allowedOrigins: moonrakerOrigins(collection),
        limits: collection.limits,
      })
      if (origin !== binding.moonraker_origin) return undefined
      const apiKey = moonrakerAuthHeaders(origin, limits)['X-Api-Key']
      return {
        upload: { backend: 'moonraker', origin, ...(apiKey ? { apiKey } : {}) },
        list: {
          backend: 'moonraker',
          client: moonrakerQueryClient(origin, limits),
          thumbnailSource: { origin, limits },
        },
      }
    }
    if (collection.version === 3) {
      const handle = input.config.bindingFor(input.assignmentId)
      const binding = handle && readBambuPrinterBinding(handle)
      if (!binding || binding.printerKey !== controlledKey) return undefined
      const credentials = readBambuCredentials(binding)
      return {
        upload: {
          backend: 'bambu',
          host: binding.host,
          serial: binding.serial,
          accessCode: credentials.password,
          port: binding.ftpsPort,
          trust: {
            ...(binding.caFile
              ? { caPem: readFileSync(binding.caFile, 'utf8') }
              : {}),
            ...(binding.pinSha256 ? { pinSha256: binding.pinSha256 } : {}),
          },
        },
        list: {
          backend: 'bambu',
          host: binding.host,
          serial: binding.serial,
          accessCode: credentials.password,
          port: binding.ftpsPort,
          trust: {
            ...(binding.caFile
              ? { caPem: readFileSync(binding.caFile, 'utf8') }
              : {}),
            ...(binding.pinSha256 ? { pinSha256: binding.pinSha256 } : {}),
          },
        },
      }
    }
    if (collection.version === 2) {
      const binding = collection.kobralink.printers.find(
        (printer) => printer.printerKey === controlledKey,
      )
      if (!binding) return undefined
      const target = createKobraLinkFilesTarget({
        binding,
        allowedOrigins: collection.kobralink.allowedOrigins,
        ...(input.kobraLinkFetch ? { fetch: input.kobraLinkFetch } : {}),
      })
      return { upload: target, list: target }
    }
    if (collection.version === 4) {
      const creality = collection.creality.printers.find(
        (printer) => printer.printerKey === controlledKey,
      )
      if (!creality) return undefined
      const binding = input.config.bindingFor(input.assignmentId)
      const local = binding && readCrealityPrinterBinding(binding)
      const host = creality.host.includes(':')
        ? `[${creality.host}]`
        : creality.host
      return {
        upload: {
          backend: 'creality',
          origin: `http://${host}:${creality.httpPort ?? 80}`,
        },
        list: {
          backend: 'creality',
          ...(binding && local?.printerKey === controlledKey
            ? { binding }
            : {}),
        },
      }
    }
    if (collection.version === 5) {
      const handle = input.config.bindingFor(input.assignmentId)
      const binding = handle && readAnycubicPrinterBinding(handle)
      if (
        handle &&
        binding?.modelId === ANYCUBIC_FILE_MODEL &&
        binding.printerKey === controlledKey
      ) {
        const target = { backend: 'anycubic', binding: handle } as const
        return { upload: target, list: target }
      }
      if (
        collection.anycubic.printers.some(
          (printer) => printer.printerKey === controlledKey,
        )
      )
        return {
          upload: { backend: 'anycubic' },
          list: { backend: 'anycubic' },
        }
    }
    return undefined
  }
  const provisioned = targets()
  const forKey = (printerKey: string) =>
    printerKey === controlledKey ? provisioned : undefined
  return {
    fileTransfer: {
      directory: join(input.dataDirectory, 'file-staging'),
      targetFor: (printerKey) => forKey(printerKey)?.upload,
    },
    fileList: { targetFor: (printerKey) => forKey(printerKey)?.list },
  }
}
