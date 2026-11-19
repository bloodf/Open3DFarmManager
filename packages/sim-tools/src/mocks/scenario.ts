// SPDX-License-Identifier: MIT

export interface ScenarioContext<TState = unknown> {
  currentStep: number
  state: TState
  updateState: (patch: Partial<TState>) => void
  publishReport: (report: unknown) => void
}

export interface ScenarioStep<TState = unknown> {
  atMs?: number
  delayMs?: number
  state?: Partial<TState>
  report?: unknown
  action?: (ctx: ScenarioContext<TState>) => void | Promise<void>
}

export type ScenarioStatus =
  'idle' | 'running' | 'paused' | 'completed' | 'stopped'

export class ScenarioController<TState = unknown> {
  private steps: ScenarioStep<TState>[]
  private stepIndex: number = 0
  private _status: ScenarioStatus = 'idle'
  private activeTimer: ReturnType<typeof setTimeout> | undefined
  private resolveRun: (() => void) | undefined
  private applyState: (patch: Partial<TState>) => void
  private publishReport: (report: unknown) => void
  private getState: () => TState

  constructor(options: {
    steps?: ScenarioStep<TState>[] | undefined
    applyState: (patch: Partial<TState>) => void
    publishReport: (report: unknown) => void
    getState: () => TState
  }) {
    this.steps = [...(options.steps ?? [])]
    this.applyState = options.applyState
    this.publishReport = options.publishReport
    this.getState = options.getState
  }

  public get status(): ScenarioStatus {
    return this._status
  }

  public get currentStep(): number {
    return this.stepIndex
  }

  public get totalSteps(): number {
    return this.steps.length
  }

  public get isCompleted(): boolean {
    return this.stepIndex >= this.steps.length
  }

  public async step(): Promise<boolean> {
    if (this.stepIndex >= this.steps.length) {
      this._status = 'completed'
      return false
    }

    const step = this.steps[this.stepIndex++]!
    if (step.state) {
      this.applyState(step.state)
    }
    if (step.report !== undefined) {
      this.publishReport(step.report)
    }
    if (step.action) {
      await step.action({
        currentStep: this.stepIndex - 1,
        state: this.getState(),
        updateState: this.applyState,
        publishReport: this.publishReport,
      })
    }

    if (this.stepIndex >= this.steps.length) {
      this._status = 'completed'
      if (this.resolveRun) {
        const resolve = this.resolveRun
        this.resolveRun = undefined
        resolve()
      }
    }

    return true
  }

  public async run(): Promise<void> {
    if (this._status === 'running') return
    if (this.stepIndex >= this.steps.length) {
      this._status = 'completed'
      return
    }

    this._status = 'running'

    return new Promise<void>((resolve) => {
      this.resolveRun = resolve
      this.scheduleNext()
    })
  }

  public pause(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer)
      this.activeTimer = undefined
    }
    this._status = 'paused'
    if (this.resolveRun) {
      const resolve = this.resolveRun
      this.resolveRun = undefined
      resolve()
    }
  }

  public async resume(): Promise<void> {
    if (this._status === 'paused' || this._status === 'idle') {
      return this.run()
    }
  }

  public reset(): void {
    this.stop()
    this.stepIndex = 0
    this._status = 'idle'
  }

  public stop(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer)
      this.activeTimer = undefined
    }
    this._status = 'stopped'
    if (this.resolveRun) {
      const resolve = this.resolveRun
      this.resolveRun = undefined
      resolve()
    }
  }

  private scheduleNext(): void {
    if (this._status !== 'running' || this.stepIndex >= this.steps.length) {
      if (this.stepIndex >= this.steps.length) {
        this._status = 'completed'
      }
      if (this.resolveRun) {
        const resolve = this.resolveRun
        this.resolveRun = undefined
        resolve()
      }
      return
    }

    const step = this.steps[this.stepIndex]!
    const delay = step.delayMs ?? (step.atMs !== undefined ? step.atMs : 10)

    this.activeTimer = setTimeout(
      () => {
        this.activeTimer = undefined
        void (async () => {
          await this.step()
          if (this._status === 'running') {
            this.scheduleNext()
          }
        })()
      },
      Math.max(0, delay),
    )
  }
}
