interface Bucket {
  tokens: number
  updatedAt: number
}

export class IntegrationLimits {
  private readonly buckets = new Map<string, Bucket>()

  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  take(key: string, limit: number) {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= 10_000) {
        for (const [id, entry] of this.buckets)
          if (now - entry.updatedAt >= 60_000) this.buckets.delete(id)
      }
      if (this.buckets.size >= 10_000) {
        const oldest = this.buckets.keys().next().value
        if (oldest !== undefined) this.buckets.delete(oldest)
      }
      bucket = { tokens: limit, updatedAt: now }
      this.buckets.set(key, bucket)
    }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(limit, bucket.tokens + (elapsed * limit) / 60_000)
    bucket.updatedAt = now
    const allowed = bucket.tokens >= 1
    if (allowed) bucket.tokens -= 1
    return {
      allowed,
      limit,
      remaining: Math.floor(bucket.tokens),
      reset: Math.ceil(((limit - bucket.tokens) * 60) / limit),
      retry: Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / limit)),
    }
  }
}
