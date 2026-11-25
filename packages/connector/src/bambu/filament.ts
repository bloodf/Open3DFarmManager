import { bambuAmsUnitId, bambuTrayAddress } from './ams.ts'

/**
 * `ams_change_filament` as bambulab/BambuStudio (AGPL-3.0) builds it, commit
 * 23a33758933e712c6041e1f8f135f7d6b50004aa, src/slic3r/GUI/DeviceManager.cpp
 * `MachineObject::command_ams_change_filament`. A load names the unit, the
 * slot and the global tray index (`target`, which is the unit id for AMS HT);
 * an unload sends `target` and `slot_id` 255 with the unit being emptied.
 * That source has no separate "select tray" request: choosing a tray is a
 * load, or the `ams_mapping` of a print start.
 *
 * `target` here is the global tray index, or 255 to unload. `unloadAmsId` is
 * left out when the loaded unit is not known.
 */
export function buildBambuFilamentCommand(
  target: number,
  targetTemp: number,
  sequenceId = '0',
  unloadAmsId?: number,
) {
  const address = bambuTrayAddress(target)
  if (!address && target !== 255) throw new Error('Invalid AMS target')
  if (
    unloadAmsId !== undefined &&
    (address || bambuAmsUnitId(unloadAmsId) !== unloadAmsId)
  )
    throw new Error('Invalid AMS unit')
  if (!Number.isInteger(targetTemp) || targetTemp < 0 || targetTemp > 300)
    throw new Error('Invalid temperature')
  if (!/^\d{1,16}$/.test(sequenceId)) throw new Error('Invalid sequence')
  const amsId = address ? address.amsId : unloadAmsId
  return {
    print: {
      command: 'ams_change_filament',
      ...(amsId === undefined ? {} : { ams_id: amsId }),
      target,
      slot_id: address ? address.slotId : 255,
      curr_temp: targetTemp,
      tar_temp: targetTemp,
      sequence_id: sequenceId,
    },
  }
}
