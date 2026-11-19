import { readFile } from 'node:fs/promises'
import { compileScript, parse } from 'vue/compiler-sfc'
import { describe, expect, it, vi } from 'vitest'
import { createFilesSession } from '../../apps/farm/app/utils/files-view-session.ts'
import {
  FileListResponse,
  MAX_PRINTER_DOWNLOAD_BYTES,
} from '../../packages/farm-protocol/src/file-list.ts'

describe('printer detail file manager', () => {
  it('compiles its panel and bindings', async () => {
    const url = new URL(
      '../../apps/farm/app/components/printer-detail/FileManagerPanel.vue',
      import.meta.url,
    )
    const { descriptor, errors } = parse(await readFile(url, 'utf8'), {
      filename: url.pathname,
    })
    expect(errors).toEqual([])
    expect(() =>
      compileScript(descriptor, { id: 'files', inlineTemplate: true }),
    ).not.toThrow()
  })

  it('reads directories and downloads on the authenticated file session', async () => {
    const entries = [
      {
        name: 'parts/subfolder',
        size: 0,
        modified: 0,
        directory: true as const,
      },
    ]
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, files: entries })
      .mockResolvedValueOnce({ ok: true, files: [], download: btoa('G28') })
    const close = vi.fn()
    const dispose = vi.fn()
    const files = vi.fn()
    const changed = vi.fn()
    const session = createFilesSession({
      available: () => true,
      connect: async () => ({
        listFiles,
        close,
        dispose,
        sendFile: vi.fn(),
        issueControlCommand: vi.fn(),
      }),
      changed,
      files,
    })
    await session.list('printer', 'parts')
    expect(listFiles).toHaveBeenNthCalledWith(1, 'printer', 'parts')
    expect(files).toHaveBeenCalledWith(entries)
    const receive = vi.fn(async (file: File) => {
      expect(file.name).toBe('part.gcode')
      expect(await file.text()).toBe('G28')
    })
    await session.download('printer', 'parts/part.gcode', receive)
    expect(listFiles).toHaveBeenNthCalledWith(
      2,
      'printer',
      undefined,
      'parts/part.gcode',
    )
    expect(receive).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('rejects downloads beyond the channel limit', () => {
    expect(
      FileListResponse.safeParse({
        type: 'files.list.result',
        request_id: 'request',
        printer_key: 'printer',
        ok: true,
        files: [],
        download: btoa('x'.repeat(MAX_PRINTER_DOWNLOAD_BYTES + 1)),
      }).success,
    ).toBe(false)
  })
})
