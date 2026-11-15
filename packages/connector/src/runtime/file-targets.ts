import { join } from 'node:path'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
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
      const host = creality.host.includes(':')
        ? `[${creality.host}]`
        : creality.host
      return {
        upload: {
          backend: 'creality',
          origin: `http://${host}:${creality.httpPort ?? 80}`,
        },
        list: { backend: 'creality' },
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
