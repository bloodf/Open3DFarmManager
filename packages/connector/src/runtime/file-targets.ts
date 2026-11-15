import { join } from 'node:path'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import { createKobraLinkFilesTarget } from '../kobralink/runtime.ts'
import type { KobraLinkFetch } from '../kobralink/client.ts'
import type { FileListOptions } from './file-list.ts'
import type { FileUploadOptions } from './file-upload.ts'

/**
 * File listing and upload for the single assignment the Connector opted in to
 * control. Targets come from the local runtime configuration only: nothing on
 * the wire selects an endpoint or a credential. A backend without a provisioned
 * target here keeps both operations unavailable.
 */
export function createFileTargets(input: {
  config: AgentRuntimeConfig
  assignmentId: string
  dataDirectory: string
  kobraLinkFetch?: KobraLinkFetch
}): { fileTransfer: FileUploadOptions; fileList: FileListOptions } | undefined {
  const { collection, assignments } = input.config
  const assignment = assignments.find(
    (entry) => entry.assignment_id === input.assignmentId,
  )
  if (!assignment || collection.version !== 2) return undefined
  const binding = collection.kobralink.printers.find(
    (printer) => printer.printerKey === assignment.printer_key,
  )
  if (!binding) return undefined
  const target = createKobraLinkFilesTarget({
    binding,
    allowedOrigins: collection.kobralink.allowedOrigins,
    ...(input.kobraLinkFetch ? { fetch: input.kobraLinkFetch } : {}),
  })
  const targetFor = (printerKey: string) =>
    printerKey === assignment.printer_key ? target : undefined
  return {
    fileTransfer: {
      directory: join(input.dataDirectory, 'file-staging'),
      targetFor,
    },
    fileList: { targetFor },
  }
}
