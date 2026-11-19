export function printStatusEta(input: {
  elapsed: number
  progress?: number | undefined
  estimatedSeconds?: number | undefined
  filamentUsed?: number | undefined
  filamentTotal?: number | undefined
  speed?: number | undefined
}) {
  const {
    elapsed,
    progress,
    estimatedSeconds,
    filamentUsed,
    filamentTotal,
    speed,
  } = input
  const positive = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0
  const remaining = (value: number) =>
    Number.isFinite(value) && value <= 365 * 86400
      ? Math.max(0, Math.ceil(value))
      : null
  return {
    file:
      positive(elapsed) && positive(progress) && progress <= 1
        ? remaining(elapsed * (1 / progress - 1))
        : null,
    slicer:
      Number.isFinite(elapsed) && elapsed >= 0 && positive(estimatedSeconds)
        ? remaining(
            (progress !== undefined && progress >= 0 && progress <= 1
              ? estimatedSeconds * (1 - progress)
              : estimatedSeconds - elapsed * (positive(speed) ? speed : 1)) /
              (positive(speed) ? speed : 1),
          )
        : null,
    filament:
      positive(elapsed) &&
      positive(filamentUsed) &&
      positive(filamentTotal) &&
      filamentUsed <= filamentTotal
        ? remaining(elapsed * (filamentTotal / filamentUsed - 1))
        : null,
  }
}
