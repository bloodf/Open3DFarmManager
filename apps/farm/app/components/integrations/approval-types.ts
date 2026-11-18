/** One held job or action as the farm page shows it. */
export interface HeldItemRow {
  kind: 'job' | 'action'
  id: string
  appName: string
  printerKey: string
  summary: string
  createdAt: number
  expiresAt: number
}
