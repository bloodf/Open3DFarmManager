import { createHmac, timingSafeEqual } from 'node:crypto'

export type Page<T> = { data: T[]; nextCursor: string | null }
export type Printer = { id: string; [key: string]: unknown }
export type PrinterStatus = { state: string; [key: string]: unknown }
export type Inventory = { data: unknown[]; nextCursor: string | null }

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export class IntegrationClient {
  readonly baseUrl: URL
  private token?: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetcher: typeof fetch

  constructor(
    baseUrl: string,
    clientId: string,
    clientSecret: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.fetcher = fetcher
    this.baseUrl = new URL('/api/integrations/v1/', baseUrl)
  }

  async authenticate(
    scopes: string[] = ['printers:read', 'inventory:read'],
  ): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopes.join(' '),
    })
    const response = await this.fetcher(new URL('oauth/token', this.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    const result = (await response.json()) as {
      access_token?: string
      error?: string
    }
    if (!response.ok || !result.access_token) {
      throw new ApiError(
        response.status,
        result.error ?? 'invalid-token',
        'Token request failed',
      )
    }
    this.token = result.access_token
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error('Authenticate before making API requests')
    const headers = new Headers(options.headers)
    headers.set('authorization', `Bearer ${this.token}`)
    if (options.body && !headers.has('content-type'))
      headers.set('content-type', 'application/json')
    const response = await this.fetcher(
      new URL(path.replace(/^\//, ''), this.baseUrl),
      { ...options, headers },
    )
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        code?: string
        detail?: string
      }
      throw new ApiError(
        response.status,
        problem.code ?? 'unknown-error',
        problem.detail ?? `Request failed (${response.status})`,
      )
    }
    return (await response.json()) as T
  }

  async listAll<T>(path: string): Promise<T[]> {
    const result: T[] = []
    let cursor: string | null = null
    do {
      const query: string = cursor
        ? `?cursor=${encodeURIComponent(cursor)}`
        : ''
      const page: Page<T> = await this.request<Page<T>>(`${path}${query}`)
      result.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return result
  }

  listPrinters(): Promise<Printer[]> {
    return this.listAll<Printer>('printers')
  }
  printerStatus(printerId: string): Promise<PrinterStatus> {
    return this.request(`printers/${encodeURIComponent(printerId)}/status`)
  }
  inventory(): Promise<Inventory[]> {
    return this.listAll<Inventory>('inventory')
  }

  submitJob(
    printerId: string,
    job: {
      fileUrl: string
      sha256: string
      sizeBytes: number
      displayName: string
    },
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<unknown> {
    return this.request(`printers/${encodeURIComponent(printerId)}/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(job),
    })
  }

  submitAction(
    printerId: string,
    action: string,
    args: object = {},
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<unknown> {
    return this.request(`printers/${encodeURIComponent(printerId)}/actions`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ action, args }),
    })
  }
}

export function verifyWebhook(
  rawBody: Buffer,
  timestamp: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!/^\d{1,16}$/.test(timestamp)) return false
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest()
  return signatureHeader.split(',').some((item) => {
    const match = /^\s*v1=([0-9a-f]{64})\s*$/.exec(item)
    if (!match) return false
    const candidate = Buffer.from(match[1]!, 'hex')
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    )
  })
}
