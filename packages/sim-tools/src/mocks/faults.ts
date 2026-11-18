// SPDX-License-Identifier: MIT

export type FaultType = 'delay' | 'drop' | 'refuse' | 'malformed' | 'stall'

export interface DelayFault {
  type: 'delay'
  delayMs: number
}

export interface DropFault {
  type: 'drop'
}

export interface RefuseFault {
  type: 'refuse'
  statusCode?: number
  code?: number
  message?: string
}

export interface MalformedFault {
  type: 'malformed'
  payload?: Buffer | string
}

export interface StallFault {
  type: 'stall'
  durationMs?: number
}

export type FaultHook =
  DelayFault | DropFault | RefuseFault | MalformedFault | StallFault

export interface FaultFilterContext {
  path?: string | undefined
  topic?: string | undefined
  method?: string | undefined
  packetType?: number | undefined
  [key: string]: unknown
}

export interface ScopedFaultRule {
  fault: FaultHook
  path?: string | RegExp
  topic?: string | RegExp
  method?: string
  count?: number
  filter?: (ctx: FaultFilterContext) => boolean
}

export class FaultController {
  private rules: ScopedFaultRule[] = []

  public setFault(fault: FaultHook | ScopedFaultRule): this {
    this.clearFaults()
    this.addFault(fault)
    return this
  }

  public addFault(fault: FaultHook | ScopedFaultRule): this {
    if ('type' in fault) {
      this.rules.push({ fault })
    } else {
      this.rules.push({ ...fault })
    }
    return this
  }

  public clearFaults(): this {
    this.rules = []
    return this
  }

  public hasFault(type?: FaultType): boolean {
    if (!type) return this.rules.length > 0
    return this.rules.some((r) => r.fault.type === type)
  }

  public matchFault(ctx: FaultFilterContext = {}): FaultHook | undefined {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i]!
      if (rule.path) {
        if (!ctx.path) continue
        if (typeof rule.path === 'string') {
          if (rule.path !== ctx.path) continue
        } else if (!rule.path.test(ctx.path)) {
          continue
        }
      }
      if (rule.topic) {
        if (!ctx.topic) continue
        if (typeof rule.topic === 'string') {
          if (rule.topic !== ctx.topic) continue
        } else if (!rule.topic.test(ctx.topic)) {
          continue
        }
      }
      if (rule.method && ctx.method) {
        if (rule.method.toUpperCase() !== ctx.method.toUpperCase()) continue
      }
      if (rule.filter && !rule.filter(ctx)) {
        continue
      }

      if (rule.count !== undefined) {
        rule.count--
        if (rule.count <= 0) {
          this.rules.splice(i, 1)
        }
      }

      return rule.fault
    }
    return undefined
  }
}
