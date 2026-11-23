import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMoonrakerConfigEditor } from '../../packages/connector/src/moonraker/control-config-editor.ts'
import {
  ControlArguments,
  controlRoleAllowed,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/index.ts'

import { createFileList } from '../../packages/connector/src/runtime/file-list.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import {
  consumeStagedConfig,
  createFileUpload,
} from '../../packages/connector/src/runtime/file-upload.ts'
import type { PauseCapabilityHandle } from '../../packages/connector/src/auth/pause-capability.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'

const path = 'printer.cfg'
const original = Buffer.from('[printer]\nmax_velocity: 100\n')
const content = Buffer.from('[printer]\nmax_velocity: 120\n')
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
let mock: Awaited<ReturnType<typeof startMoonrakerMock>> | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

async function setup(state: 'standby' | 'printing' = 'standby') {
  mock = await startMoonrakerMock({
    initial: { state },
    configfileSettings: {},
    configFiles: [{ path, content: original }],
  })
  const editor = createMoonrakerConfigEditor(mock.origin)
  return {
    editor,
    input: {
      path,
      content,
      sha256: digest(content),
      base_sha256: digest(original),
      signal: AbortSignal.timeout(5000),
      authorize: () => controlRoleAllowed('owner', 'config_write'),
    },
  }
}

describe('Moonraker configuration storage', () => {
  it('reads config bytes through the file channel only with an authorized capability', async () => {
    await setup()
    const origin = mock!.origin
    const reply = vi.fn()
    let role = 'operator'
    const handle = {
      get current() {
        return {
          role,
          printer_key: 'printer',
          actions: actionsForControlRole(role, ['config_write']),
        }
      },
    } as unknown as PauseCapabilityHandle
    const files = createFileList({
      admittedHandle: () => handle,
      send: reply,
      targetFor: () => ({
        backend: 'moonraker',
        client: {
          request: async () => {
            throw Error('Unexpected G-code request')
          },
        },
        thumbnailSource: {
          origin,
          limits: {
            maxMessageBytes: 65536,
            connectTimeoutMs: 500,
            requestTimeoutMs: 500,
            staleAfterMs: 2000,
            reconnectMinMs: 100,
            reconnectMaxMs: 100,
          },
        },
      }),
    })
    const request = {
      type: 'files.list',
      printer_key: 'printer',
      request_id: randomUUID(),
      config: true,
      configPath: path,
    }
    try {
      expect(files.receive(JSON.stringify(request))).toBe(true)
      await files.settled()
      expect(JSON.parse(reply.mock.lastCall![0])).toMatchObject({
        ok: false,
        reason: 'unauthorized',
      })
      role = 'admin'
      expect(files.receive(JSON.stringify(request))).toBe(true)
      await files.settled()
      expect(JSON.parse(reply.mock.lastCall![0])).toMatchObject({
        ok: true,
        request_id: request.request_id,
        download: original.toString('base64'),
        config: {
          sha256: digest(original),
          size: original.length,
          backups: [],
        },
      })
    } finally {
      files.close()
      await files.settled()
    }
  })

  it('keeps ten backups and requests a single firmware restart after writing', async () => {
    const { editor, input } = await setup()
    let base = input.base_sha256
    for (let i = 0; i < 11; i++) {
      const next = Buffer.from(`# config version ${i}\n`)
      const sha256 = digest(next)
      await editor.write({ ...input, content: next, sha256, base_sha256: base })
      base = sha256
    }
    expect((await editor.read(path, input.signal)).backups).toHaveLength(10)
    await editor.write({ ...input, base_sha256: base, restart: true })
    expect(mock!.calls()['HTTP POST /printer/firmware_restart']).toBe(1)
  })

  it('executes a staged config write through the prepared Moonraker driver', async () => {
    const { editor, input } = await setup()
    const origin = mock!.origin
    const transportId = randomUUID()
    const printerKey = 'printer-config'
    const directory = await mkdtemp(join(tmpdir(), 'openfarm-config-transfer-'))
    const reply = vi.fn()
    let role = 'operator'
    const handle = {
      get current() {
        return {
          role,
          printer_key: printerKey,
          transport_id: transportId,
          actions: ['config_write'],
        }
      },
    } as unknown as PauseCapabilityHandle
    function createUpload() {
      return createFileUpload({
        directory,
        targetFor: () => ({ backend: 'moonraker', origin }),
        admittedHandle: () => handle,
        send: reply,
      })
    }
    const offer = JSON.stringify({
      type: 'offer',
      config: true,
      transfer_id: randomUUID(),
      name: path,
      printer_key: printerKey,
      sha256: input.sha256,
      size: content.length,
    })
    const refused = createUpload()
    const upload = createUpload()
    const binding = createPrinterBindingRegistry({
      allowedOrigins: [origin],
    }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: printerKey,
      moonraker_origin: origin,
    })
    const fixed = openFixedMoonrakerPause({
      binding,
      allowedOrigins: [origin],
      connectionGeneration: 1,
      publish: () => {},
      signal: input.signal,
      clock: { monotonicNow: () => performance.now() },
      limits: {
        maxMessageBytes: 65536,
        connectTimeoutMs: 500,
        requestTimeoutMs: 500,
        staleAfterMs: 2000,
        reconnectMinMs: 100,
        reconnectMaxMs: 100,
      },
      objects: ['configfile', 'print_stats'],
    })
    try {
      refused.receive(offer)
      await refused.settled()
      expect(JSON.parse(reply.mock.lastCall![0])).toMatchObject({
        ok: false,
        reason: 'unauthorized',
      })
      role = 'admin'
      const chunk = Buffer.alloc(4 + content.length)
      content.copy(chunk, 4)
      for (const message of [
        offer,
        chunk,
        JSON.stringify({ type: 'complete' }),
      ]) {
        upload.receive(message)
        await upload.settled()
      }
      expect(JSON.parse(reply.mock.lastCall![0])).toMatchObject({ ok: true })
      expect((await editor.read(path, input.signal)).bytes).toEqual(original)
      await fixed.prepare()
      const guard = vi.fn(() => true)
      await expect(
        fixed.driver.execute!(
          'config_write',
          {
            path,
            sha256: input.sha256,
            base_sha256: input.base_sha256,
          },
          {
            binding,
            transportId,
            beforeSend: guard,
            stillAuthorized: input.authorize,
            signal: input.signal,
          },
        ),
      ).resolves.toEqual({ acknowledged: true })
      expect(guard).toHaveBeenCalledOnce()
      expect(await editor.read(path, input.signal)).toMatchObject({
        bytes: content,
        backups: [expect.stringMatching(/\.bak$/)],
      })
    } finally {
      await fixed.close()
      await refused.close()
      await upload.close()
      await rmdir(directory)
    }
  })

  it('keeps a staged config after the file channel closes and clears it with the peer', async () => {
    const { input } = await setup()
    const origin = mock!.origin
    const transportId = randomUUID()
    const directory = await mkdtemp(join(tmpdir(), 'openfarm-config-stage-'))
    const handle = {
      current: {
        role: 'admin',
        printer_key: 'printer-config',
        transport_id: transportId,
        actions: ['config_write'],
      },
    } as unknown as PauseCapabilityHandle
    const offer = JSON.stringify({
      type: 'offer',
      config: true,
      transfer_id: randomUUID(),
      name: path,
      printer_key: 'printer-config',
      sha256: input.sha256,
      size: content.length,
    })
    const chunk = Buffer.alloc(4 + content.length)
    content.copy(chunk, 4)
    const stage = async () => {
      const upload = createFileUpload({
        directory,
        targetFor: () => ({ backend: 'moonraker', origin }),
        admittedHandle: () => handle,
        send: () => {},
      })
      for (const message of [
        offer,
        chunk,
        JSON.stringify({ type: 'complete' }),
      ]) {
        upload.receive(message)
        await upload.settled()
      }
      return upload
    }
    try {
      // The browser closes the channel when the transfer ends; the signed
      // write follows on the control channel and still finds the payload.
      const channelClosed = await stage()
      await channelClosed.close({ keepStaged: true })
      expect(consumeStagedConfig(transportId, path, input.sha256)).toEqual(
        content,
      )
      expect(
        consumeStagedConfig(transportId, path, input.sha256),
      ).toBeUndefined()
      // The peer's own close clears it.
      const peerClosed = await stage()
      await peerClosed.close()
      expect(
        consumeStagedConfig(transportId, path, input.sha256),
      ).toBeUndefined()
    } finally {
      await rmdir(directory)
    }
  })

  it('lists config files, saves with a backup and restores the previous bytes', async () => {
    const { editor, input } = await setup()
    expect(await editor.list(input.signal)).toEqual([path])
    const backup = await editor.write(input)
    expect(await editor.read(path, input.signal)).toEqual({
      bytes: content,
      sha256: digest(content),
      backups: [backup],
    })
    const args = { path, base_sha256: digest(content), backup }
    expect(
      ControlArguments.parse({ action: 'config_write', args }).args,
    ).toEqual(args)
    const restoreBackup = await editor.restore({
      ...args,
      signal: input.signal,
      authorize: input.authorize,
    })
    expect(await editor.read(path, input.signal)).toEqual({
      bytes: original,
      sha256: digest(original),
      backups: [restoreBackup, backup],
    })
  })

  it('refuses printing before creating a backup', async () => {
    const { editor, input } = await setup('printing')
    await expect(editor.write(input)).rejects.toMatchObject({ reason: 'state' })
    expect(await editor.read(path, input.signal)).toMatchObject({
      bytes: original,
      backups: [],
    })
  })

  it('refuses a stale base and an operator on a stopped printer', async () => {
    const { editor, input } = await setup()
    await expect(
      editor.write({ ...input, base_sha256: input.sha256 }),
    ).rejects.toMatchObject({ reason: 'base-mismatch' })
    await expect(
      editor.write({
        ...input,
        authorize: () => controlRoleAllowed('operator', 'config_write'),
      }),
    ).rejects.toMatchObject({ reason: 'unauthorized' })
    expect(await editor.read(path, input.signal)).toMatchObject({
      bytes: original,
      backups: [],
    })
  })
})
