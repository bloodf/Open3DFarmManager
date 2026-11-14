import assert from 'node:assert/strict'
import { expect, type Page } from '@playwright/test'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const ALLOWED_WS_T = new Set([
  'config.begin',
  'config.ready',
  'config.binding',
  'config.context-closed',
  'rtc.offer',
  'rtc.answer',
  'rtc.ice',
  'rtc.close',
  'browser.begin',
  'browser.ready',
])

function safeFrameType(raw: string | Buffer): string {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    const parsed: unknown = JSON.parse(text)
    const t =
      parsed && typeof parsed === 'object' && 't' in parsed
        ? parsed.t
        : undefined
    return typeof t === 'string' && ALLOWED_WS_T.has(t) ? t : 'other'
  } catch {
    return 'invalid'
  }
}

/** Called only by the admitted sealed-Nitro runner; no HTTP interception. */
export async function driveFirstRegistration(input: {
  page: Page
  origin: string
  farmId: string
  agentId: string
  browserKeyId: string
  evidence: string
  events: readonly Readonly<Record<string, unknown>>[]
}) {
  const { page } = input
  const t0 = performance.now()
  const record = (entry: Readonly<Record<string, unknown>>) =>
    appendFile(
      join(input.evidence, 'boundary.jsonl'),
      JSON.stringify({
        atMs: Math.round(performance.now() - t0),
        ...entry,
      }) + '\n',
      { mode: 0o600 },
    ).catch(() => {})
  page.on('console', (msg) => {
    const text = msg.text()
    if (!text.startsWith('__RTC_DIAG__:')) return
    try {
      const payload: unknown = JSON.parse(text.slice('__RTC_DIAG__:'.length))
      if (payload && typeof payload === 'object')
        void record({
          side: 'browser-rtc',
          ...(payload as Record<string, unknown>),
        })
    } catch {}
  })
  page.on('response', (res) => {
    try {
      const url = new URL(res.url())
      if (url.pathname.startsWith('/api/'))
        void record({
          side: 'browser-http',
          method: res.request().method(),
          path: url.pathname,
          status: res.status(),
        })
    } catch {}
  })
  page.on('requestfailed', (req) => {
    try {
      const url = new URL(req.url())
      if (url.pathname.startsWith('/api/'))
        void record({
          side: 'browser-http-failed',
          method: req.method(),
          path: url.pathname,
        })
    } catch {}
  })
  page.on('websocket', (ws) => {
    let path = 'unknown'
    try {
      path = new URL(ws.url()).pathname
    } catch {}
    void record({ side: 'browser-ws', state: 'open', path })
    ws.on('framesent', ({ payload }) => {
      void record({
        side: 'browser-ws-out',
        path,
        t: safeFrameType(payload),
        bytes:
          typeof payload === 'string' ? payload.length : payload.byteLength,
      })
    })
    ws.on('framereceived', ({ payload }) => {
      void record({
        side: 'browser-ws-in',
        path,
        t: safeFrameType(payload),
        bytes:
          typeof payload === 'string' ? payload.length : payload.byteLength,
      })
    })
    ws.on('socketerror', () => {
      void record({ side: 'browser-ws', state: 'error', path })
    })
    ws.on('close', () => {
      void record({ side: 'browser-ws', state: 'close', path })
    })
  })
  await page.addInitScript(() => {
    const OriginalPeer = window.RTCPeerConnection
    const ALLOWED_DC_T = new Set([
      'proof',
      'request',
      'response',
      'inventory',
      'inventory-result',
    ])
    const ALLOWED_FRAME_TYPE = new Set([
      'prepare',
      'commit',
      'status',
      'cancel',
      'result',
      'unknown',
      'error',
    ])
    const ALLOWED_STATE = new Set([
      'prepared',
      'local-committed',
      'inventory-confirmed',
      'recovery-required',
    ])
    let seq = 0
    const emit = (data: Record<string, unknown>) => {
      console.debug('__RTC_DIAG__:' + JSON.stringify(data))
    }
    const msgSummary = (raw: unknown) => {
      try {
        if (typeof raw !== 'string') return { t: 'non-string' }
        const outer = JSON.parse(raw)
        const t =
          typeof outer?.t === 'string' && ALLOWED_DC_T.has(outer.t)
            ? outer.t
            : 'other'
        const summary: Record<string, unknown> = { t }
        if (typeof outer?.frame === 'string') {
          const inner = JSON.parse(outer.frame)
          summary.frameType =
            typeof inner?.type === 'string' &&
            ALLOWED_FRAME_TYPE.has(inner.type)
              ? inner.type
              : 'other'
          summary.frameState =
            typeof inner?.state === 'string' && ALLOWED_STATE.has(inner.state)
              ? inner.state
              : null
          summary.frameCode =
            typeof inner?.code === 'string' &&
            /^[a-z0-9-]{1,40}$/.test(inner.code)
              ? inner.code
              : null
        }
        if (t === 'inventory-result') {
          summary.ok = Boolean(outer?.ok)
        }
        return summary
      } catch {
        return { t: 'invalid' }
      }
    }
    class DiagnosticPeer extends OriginalPeer {
      constructor(config?: RTCConfiguration) {
        super(config)
        const id = ++seq
        emit({ peerId: id, event: 'created' })
        this.addEventListener('signalingstatechange', () =>
          emit({ peerId: id, event: 'signaling', state: this.signalingState }),
        )
        this.addEventListener('icegatheringstatechange', () =>
          emit({
            peerId: id,
            event: 'gathering',
            state: this.iceGatheringState,
          }),
        )
        this.addEventListener('iceconnectionstatechange', () =>
          emit({ peerId: id, event: 'ice', state: this.iceConnectionState }),
        )
        this.addEventListener('connectionstatechange', () =>
          emit({
            peerId: id,
            event: 'connection',
            state: this.connectionState,
          }),
        )
        this.addEventListener('datachannel', (ev) => {
          const ch = ev.channel
          emit({
            peerId: id,
            event: 'dc-received',
            readyState: ch.readyState,
          })
          ch.addEventListener('open', () =>
            emit({ peerId: id, event: 'dc-open' }),
          )
          ch.addEventListener('close', () =>
            emit({ peerId: id, event: 'dc-close' }),
          )
          ch.addEventListener('error', () =>
            emit({ peerId: id, event: 'dc-error' }),
          )
          ch.addEventListener('message', (mev) =>
            emit({ peerId: id, event: 'dc-in', ...msgSummary(mev.data) }),
          )
          const origSend = ch.send.bind(ch)
          ch.send = ((data: string) => {
            emit({ peerId: id, event: 'dc-out', ...msgSummary(data) })
            return origSend(data)
          }) as typeof ch.send
        })
      }
      override async setRemoteDescription(
        desc: RTCSessionDescriptionInit,
      ): Promise<void> {
        const sdp = desc.sdp ?? ''
        emit({
          event: 'setRemoteDescription',
          type: desc.type,
          candidates: (sdp.match(/^a=candidate:/gm) ?? []).length,
          hasMdns: /\.local\b/i.test(sdp),
        })
        return super.setRemoteDescription(desc)
      }
      override async setLocalDescription(
        desc?: RTCLocalSessionDescriptionInit,
      ): Promise<void> {
        await super.setLocalDescription(desc)
        const sdp = this.localDescription?.sdp ?? ''
        emit({
          event: 'setLocalDescription',
          type: this.localDescription?.type ?? null,
          candidates: (sdp.match(/^a=candidate:/gm) ?? []).length,
          hasMdns: /\.local\b/i.test(sdp),
        })
      }
    }
    window.RTCPeerConnection = DiagnosticPeer
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  page.setDefaultTimeout(30_000)
  await page.goto(input.origin + '/impressoras')
  await page.getByLabel('Farm', { exact: true }).selectOption(input.farmId)
  await page
    .getByLabel('Connector aprovado para a Kobra X')
    .selectOption(input.agentId)
  await page
    .getByLabel('Dispositivo aprovado deste navegador', { exact: true })
    .selectOption(input.browserKeyId)
  await expect
    .poll(
      async () => {
        await page
          .getByRole('button', { name: 'Verificar capacidade do Connector' })
          .click()
        return expect(page.getByLabel('Endereço IPv4 da Kobra X na LAN'))
          .toBeEnabled({ timeout: 3000 })
          .then(
            () => true,
            () => false,
          )
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true)
  await page.getByLabel('Endereço IPv4 da Kobra X na LAN').fill('172.30.78.3')
  await page
    .getByLabel('Apelido local para identificação (opcional)')
    .fill('Kobra sintética RTC')
  await expect(page.locator('#kobra-device-id')).toHaveValue('')
  await page
    .getByRole('button', { name: 'Preparar Anycubic Kobra X', exact: true })
    .click()
  await expect(page.locator('#kobra-confirm-checkbox')).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.getByText('OPENFARM_SYNTHETIC_KOBRA_X_001', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: join(input.evidence, 'prepared-desktop1280.png'),
    fullPage: true,
  })
  assert.equal(
    input.events.some(
      (e) => e.kind === 'runtime-activation' && e.result === 'activated',
    ),
    false,
    'Collector must remain stopped before inventory confirmation',
  )
  await page.locator('#kobra-confirm-checkbox').check()
  await page
    .getByRole('button', { name: 'Confirmar e ativar Kobra X', exact: true })
    .click()
  await expect(
    page.getByRole('heading', {
      name: 'Anycubic Kobra X confirmada e ativa em modo somente leitura',
    }),
  ).toBeVisible({ timeout: 60_000 })
  const localCommitIdx = input.events.findIndex(
    (e) =>
      e.kind === 'configuration-activation' &&
      e.reason === 'local-commit' &&
      e.result === 'unconfirmed',
  )
  const confirmedIdx = input.events.findIndex(
    (e) =>
      e.kind === 'configuration-activation' &&
      e.reason === 'inventory-confirmed' &&
      e.result === 'activated',
  )
  assert.ok(
    localCommitIdx >= 0 && confirmedIdx > localCommitIdx,
    'Local commit must remain unconfirmed until signed inventory acknowledgement activates collection',
  )
  await page.screenshot({
    path: join(input.evidence, 'confirmed-desktop1280.png'),
    fullPage: true,
  })
  assert.equal(
    page
      .context()
      .pages()
      .filter((p) => new URL(p.url()).origin !== input.origin).length,
    0,
  )
  assert.equal(await page.locator('iframe').count(), 0)
  await page.goto(input.origin + '/farm')
  await expect(
    page.getByText('Conexão direta autenticada', { exact: true }),
  ).toBeVisible({ timeout: 60_000 })
  const articles = page.getByRole('article')
  await expect(articles).toHaveCount(1)
  await expect(
    articles.first().getByText('Ociosa', { exact: true }),
  ).toBeVisible()
  assert.equal(await page.locator('iframe, video').count(), 0)
  await page.screenshot({
    path: join(input.evidence, 'live-desktop1280.png'),
    fullPage: true,
  })
}
