export interface ChartPoint {
  /** Unix time in milliseconds. */
  time: number
  value: number
}

export function sortedPoints(points: readonly ChartPoint[]) {
  return points
    .filter(
      ({ time, value }) =>
        Number.isFinite(time) &&
        Math.abs(time) <= 8.64e15 &&
        Number.isFinite(value),
    )
    .sort((a, b) => a.time - b.time)
}

export function scale(min: number, max: number, start: number, end: number) {
  return (value: number) =>
    min === max
      ? (start + end) / 2
      : start + ((value - min) / (max - min)) * (end - start)
}
