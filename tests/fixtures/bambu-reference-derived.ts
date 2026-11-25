/**
 * Reference-derived Bambu report fragments. NOT captured from any printer.
 *
 * Shapes follow the parsers of bambulab/BambuStudio (AGPL-3.0), commit
 * 23a33758933e712c6041e1f8f135f7d6b50004aa, src/slic3r/GUI/DeviceCore/:
 * DevFilaSystem.cpp (units, trays, `info`), DevExtruderSystem.cpp
 * (`device.extruder`), DevNozzleSystem.cpp (`device.nozzle`), DevFan.cpp
 * (`device.airduct`) and DevChamber.cpp (`ctt`). All values are invented.
 */
const tray = (id: number, type: string, color: string) => ({
  id: String(id),
  tray_info_idx: 'GFA00',
  tray_type: type,
  tray_color: color,
  remain: 80,
})

/** Two 4-slot units and one AMS HT. `info`: type in bits 0-3, extruder 8-11. */
export function expandedAms() {
  return {
    ams_exist_bits: '13',
    tray_exist_bits: '10013',
    tray_now: '255',
    ams: [
      {
        id: '0',
        info: '1001',
        tray: [
          tray(0, 'PLA', 'FF0000FF'),
          tray(1, 'PETG', '00FF00FF'),
          { id: '2' },
          { id: '3' },
        ],
      },
      {
        id: '1',
        info: '1103',
        tray: [tray(0, 'ABS', '0000FFFF'), { id: '1' }],
      },
      { id: '128', info: '1104', tray: [tray(0, 'PA', '000000FF')] },
    ],
  }
}

const airPart = (id: number) => ({
  id: id << 4,
  func: 0,
  state: 0,
  range: 100 << 16,
})

/** H2D-like report: two extruders, chamber heater, air duct, two ext spools. */
export function dualNozzleReport() {
  return {
    cfg: '0',
    // Bit 39: bed temperature over `set_bed_temp`.
    fun: '8000000000',
    aux: '0',
    stat: '0',
    ctt: 0,
    chamber_temper: 28,
    nozzle_diameter: '0.4',
    device: {
      extruder: {
        // Bits 0-3: two extruders.
        state: 2,
        info: [
          { id: 0, temp: 25, snow: 0xffff },
          { id: 1, temp: 25, snow: 0xffff },
        ],
      },
      nozzle: {
        info: [
          { id: 0, diameter: 0.4, type: 'HS01' },
          { id: 1, diameter: 0.6, type: 'HS01' },
        ],
      },
      airduct: { modeCur: 0, parts: [airPart(1), airPart(2), airPart(3)] },
    },
    vir_slot: [
      { id: '255', tray_type: 'TPU', tray_color: 'FFFFFFFF' },
      { id: '254' },
    ],
    ams: expandedAms(),
  }
}
