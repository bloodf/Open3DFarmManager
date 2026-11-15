export function buildBambuFilamentCommand(
  target: number,
  targetTemp: number,
  sequenceId = '0',
) {
  if (
    !Number.isInteger(target) ||
    !((target >= 0 && target <= 15) || target === 255)
  )
    throw new Error('Invalid AMS target')
  if (!Number.isInteger(targetTemp) || targetTemp < 0 || targetTemp > 300)
    throw new Error('Invalid temperature')
  if (!/^\d{1,16}$/.test(sequenceId)) throw new Error('Invalid sequence')
  return {
    print: {
      command: 'ams_change_filament',
      target,
      curr_temp: targetTemp,
      tar_temp: targetTemp,
      sequence_id: sequenceId,
    },
  }
}
