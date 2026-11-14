import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { transformSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

// Execute the production setup functions with controlled async boundaries.
const require = createRequire(resolve('apps/farm/package.json'))
const { parse, compileScript } = require('vue/compiler-sfc')
const source = readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'presend-test' })
const names = new Set(['prepareKobraX', 'handleKobraException'])
const functions = compiled.scriptSetupAst.filter(
  (node: { type: string; id?: { name: string } }) =>
    node.type === 'FunctionDeclaration' && names.has(node.id?.name ?? ''),
)
const javascript = transformSync(
  functions
    .map((node: { start: number; end: number }) =>
      descriptor.scriptSetup.content.slice(node.start, node.end),
    )
    .join('\n'),
  { loader: 'ts', target: 'es2022' },
).code

function harness() {
  const ref = <T>(value: T) => ({ value })
  const context = {
    kobraBusy: ref(false),
    kobraBootstrap: ref({
      kind: 'ready',
      data: { bootstrap: { revision: 0 } },
    }),
    kobraError: ref(''),
    kobraStatus: ref(''),
    kobraIp: ref('192.168.1.2'),
    kobraLabel: ref('Kobra'),
    kobraExpectedDeviceId: ref(''),
    kobraGeneration: 1,
    kobraController: null as AbortController | null,
    kobraStage: ref('idle'),
    kobraKeyState: ref({ kind: 'available', accountId: 'account-a' }),
    farmId: ref('farm'),
    kobraAgentId: ref('agent'),
    kobraKeyId: ref('key'),
    kobraOperation: ref<unknown>(null),
    kobraUnknownNotice: ref(''),
    kobraErrorSummary: ref(null),
    validateKobraXTargetInput: () => ({
      ok: true,
      target: {},
      displayLabel: 'Kobra',
    }),
    configurationTargetHash: vi.fn(async () => 'hash'),
    persistPendingOperation: vi.fn(),
    ensureKobraSession: vi.fn(),
    applySessionOutcome: vi.fn(),
    closeKobraSession: vi.fn(),
    nextTick: async () => {},
    AbortController,
    crypto,
  }
  const prepare = new Function(
    'context',
    `with (context) { ${javascript}; return prepareKobraX }`,
  )(context)
  return { context, prepare }
}

describe('Kobra prepare dispatch recovery', () => {
  it.each([new Error('connection refused'), { statusCode: 403 }])(
    'keeps pre-send failures usable without a pending operation: %s',
    async (error) => {
      const { context, prepare } = harness()
      context.ensureKobraSession.mockRejectedValueOnce(error)
      await prepare()
      expect(context.kobraStage.value).toBe('idle')
      expect(context.kobraOperation.value).toBeNull()
      expect(context.persistPendingOperation).not.toHaveBeenCalled()
      expect(context.kobraIp.value).toBe('192.168.1.2')
      context.ensureKobraSession.mockResolvedValue({
        prepare: async ({ beforeDispatch }: { beforeDispatch: () => void }) => {
          beforeDispatch()
          return { kind: 'prepared' }
        },
      })
      await prepare()
      expect(context.applySessionOutcome).toHaveBeenCalledOnce()
    },
  )

  it.each([new Error('timeout'), { statusCode: 403 }])(
    'retains the exact operation after dispatch uncertainty: %s',
    async (error) => {
      const { context, prepare } = harness()
      context.ensureKobraSession.mockResolvedValue({
        prepare: async ({ beforeDispatch }: { beforeDispatch: () => void }) => {
          beforeDispatch()
          throw error
        },
      })
      await prepare()
      expect(context.kobraStage.value).toBe('awaiting-reconcile')
      expect(context.persistPendingOperation).toHaveBeenLastCalledWith(
        context.kobraOperation.value,
        'awaiting-reconcile',
      )
      expect(context.kobraOperation.value).not.toBeNull()
    },
  )

  it('refuses a stale account generation before dispatch', async () => {
    const { context, prepare } = harness()
    context.ensureKobraSession.mockResolvedValue({
      prepare: async ({ beforeDispatch }: { beforeDispatch: () => void }) => {
        context.kobraGeneration++
        beforeDispatch()
      },
    })
    await prepare()
    expect(context.persistPendingOperation).not.toHaveBeenCalled()
    expect(context.kobraOperation.value).toBeNull()
    expect(context.applySessionOutcome).not.toHaveBeenCalled()
  })
  it('does not persist when cancelled before dispatch', async () => {
    const { context, prepare } = harness()
    context.ensureKobraSession.mockResolvedValue({
      prepare: async ({
        beforeDispatch,
        signal,
      }: {
        beforeDispatch: () => void
        signal: AbortSignal
      }) => {
        context.kobraController?.abort()
        expect(signal.aborted).toBe(true)
        beforeDispatch()
      },
    })
    await prepare()
    expect(context.persistPendingOperation).not.toHaveBeenCalled()
    expect(context.kobraStage.value).toBe('idle')
  })

  it('does not let a late old-account failure overwrite the new generation', async () => {
    const { context, prepare } = harness()
    context.ensureKobraSession.mockResolvedValue({
      prepare: async ({ beforeDispatch }: { beforeDispatch: () => void }) => {
        beforeDispatch()
        context.kobraGeneration++
        context.kobraOperation.value = null
        context.kobraStage.value = 'idle'
        throw new Error('late reply from account-a')
      },
    })
    await prepare()
    expect(context.persistPendingOperation).toHaveBeenCalledTimes(1)
    expect(context.kobraOperation.value).toBeNull()
    expect(context.kobraStage.value).toBe('idle')
  })
})
