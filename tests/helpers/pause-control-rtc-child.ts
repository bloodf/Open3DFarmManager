import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
const native: typeof import('../../packages/connector/node_modules/node-datachannel') =
  createRequire(
    new URL('../../packages/connector/package.json', import.meta.url),
  )('node-datachannel')
const { cleanup, getLibraryVersion } = native
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PauseConnectorPeer } from '../../packages/connector/src/webrtc/pause-control-peer.ts'
import {
  PauseExpectedContext,
  type PauseProofsReady,
  type PausePhaseFrame,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'
import { PauseChannelFrame } from '../../packages/farm-protocol/src/pause-channel.ts'

const Command = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hello') }),
  z.strictObject({ kind: z.literal('offer'), expected: PauseExpectedContext }),
  z.strictObject({ kind: z.literal('answer'), sdp: z.string().max(7000) }),
  z.strictObject({ kind: z.literal('admit'), binding: z.unknown() }),
  z.strictObject({ kind: z.literal('nonce'), frame: PauseChannelFrame }),
  z.strictObject({ kind: z.literal('snapshot') }),
  z.strictObject({ kind: z.literal('close') }),
])
const identity = new ConnectorIdentity(
  generateKeyPairSync('ed25519').privateKey,
)
let peer: PauseConnectorPeer | undefined
let resolveBinding: ((value: unknown) => void) | undefined
let ready: PauseProofsReady | undefined
const phases: Readonly<PausePhaseFrame>[] = []
let reason: string | undefined
let terminals = 0,
  settled = false,
  closing = false,
  busy = false
let carry = Buffer.alloc(0)
let active = Promise.resolve()
function output(value: unknown) {
  const wire = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(wire) > 65536) throw Error('Fixture output bound')
  process.stdout.write(wire)
}
async function stop() {
  if (closing) return
  closing = true
  process.stdin.pause()
  await active.catch(() => {})
  try {
    peer?.close('fixture-stop')
    await peer?.closed
  } finally {
    cleanup()
  }
}
function snapshot() {
  if (!peer) throw Error('Missing peer')
  return {
    diagnostics: peer.diagnostics(),
    ready,
    phases,
    terminals,
    settled,
    reason,
  }
}
async function command(input: unknown) {
  const value = Command.parse(input)
  switch (value.kind) {
    case 'hello':
      return {
        spki: identity.publicKeySpki,
        fingerprint: identity.fingerprint,
        pid: process.pid,
        runtime: process.version,
        native: getLibraryVersion(),
      }
    case 'offer': {
      if (peer) throw Error('One peer per child')
      const expectedBinding = new Promise<unknown>((resolve) => {
        resolveBinding = resolve
      })
      peer = new PauseConnectorPeer({
        identity,
        expected: value.expected,
        expectedBinding,
        onProofsReady(value) {
          ready = value
        },
        onPhase(value) {
          if (phases.length >= 2) throw Error('Fixture phase capacity')
          phases.push(value)
        },
        onTerminal(value) {
          terminals++
          reason = value
        },
      })
      void peer.closed.then(() => {
        settled = true
      })
      return { sdp: await peer.offer() }
    }
    case 'answer':
      if (!peer) throw Error('Missing peer')
      peer.answer(value.sdp)
      return { ok: true }
    case 'admit': {
      if (!resolveBinding) throw Error('Missing synthetic binding resolver')
      const resolve = resolveBinding
      resolveBinding = undefined
      resolve(value.binding)
      return { ok: true }
    }
    case 'nonce': {
      if (!peer || value.frame.t !== 'control.admission-nonce')
        throw Error('Wrong fixture phase')
      const { admission_nonce, issued_at, expires_at } = value.frame
      return {
        sent: peer.sendPhase({
          t: 'control.admission-nonce',
          admission_nonce,
          issued_at,
          expires_at,
        }),
      }
    }
    case 'snapshot':
      return snapshot()
    case 'close':
      peer?.close('fixture-close')
      await peer?.closed
      return snapshot()
  }
}
process.stdin.on('data', (chunk: Buffer) => {
  if (closing) return
  if (busy || carry.length + chunk.length > 65536) {
    void stop()
    return
  }
  carry = Buffer.concat([carry, chunk])
  const end = carry.indexOf(10)
  if (end < 0) return
  if (end !== carry.length - 1) {
    void stop()
    return
  }
  const line = carry.subarray(0, end)
  carry = Buffer.alloc(0)
  busy = true
  active = (async () => {
    try {
      output(
        await command(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)),
        ),
      )
    } catch {
      output({ error: 'Fixture command rejected' })
    }
  })().finally(() => {
    busy = false
  })
  void active.catch(() => {
    void stop()
  })
})
process.stdin.on('end', () => {
  void stop()
})
process.stdin.on('error', () => {
  void stop()
})
process.stdout.on('error', () => {
  void stop()
})
process.on('SIGTERM', () => {
  void stop()
})
