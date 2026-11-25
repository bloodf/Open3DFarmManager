// Read-only Klipper object names per provisioned Qidi model. A role is listed
// only where a pinned Qidi source names it; an absent role stays unknown.
// Sources and refusals: docs/fullfarmmanager/evidence/qidi.md

export const QIDI_MODELS = [
  'Q1 Pro',
  'Plus4',
  'Q2',
  'Max4',
  'X-Max 3',
  'X-Plus 3',
  'X-Smart 3',
] as const
export type QidiModel = (typeof QIDI_MODELS)[number]

export type QidiProfile = Readonly<{
  partFan: string
  /** Several objects form one auxiliary reading, shown only when they agree. */
  auxFans: readonly string[]
  chamberFan?: string
  chamberHeater?: string
  /** QIDI Box slot status object. */
  box?: string
}>

// config/printer.cfg (sections) and the M106 P0/P2/P3 and M141 macros:
// QIDITECH/QIDI_Q1_Pro@b4b417116f6c44d1d1c0a4ef3f3f9a7cdb5dbdaf
// QIDITECH/QIDI_PLUS4@c4398bedad11e85ddfaf197e25a2c7154315d498
// QIDITECH/QIDI_Q2@3f6bcc8bc295ecf067b45345c5bdb2139b287f17
const qSeries: QidiProfile = {
  partFan: 'fan_generic cooling_fan',
  auxFans: ['fan_generic auxiliary_cooling_fan'],
  chamberFan: 'fan_generic chamber_circulation_fan',
  chamberHeater: 'heater_generic chamber',
}

// The X-Max 3 and X-Smart 3 screen clients subscribe `fan` and three output
// pins plus `heater_generic hot` without naming what the latter four drive.
// QIDITECH/QIDI_MAX3@ec0932953b394552a4327e8682accf119795bacb
// QIDITECH/QIDI_SMART3@2adb47605453561985d6cfd3089bd185a3f4e01d
// src/mks_printer.cpp, subscribe_objects_status
const standardFanOnly: QidiProfile = { partFan: 'fan', auxFans: [] }

export const QIDI_PROFILES: Readonly<Record<QidiModel, QidiProfile>> = {
  'Q1 Pro': qSeries,
  Plus4: qSeries,
  Q2: qSeries,
  // QIDITECH/QIDI_MAX4@47fc14cefe064dbd30b90582429fe650883ae900
  // config/printer.cfg declares [multi_color_controller] and two auxiliary
  // fans; config/klipper-macros-qd/fans.cfg drives both with M106 P2, and
  // heaters.cfg points M141 at the chamber heater.
  // The Box fields are read by QIDITECH/QIDIStudio (AGPL-3.0)
  // @21d47457919212b8af3f97705716c261b97be559
  // src/slic3r/GUI/QDSDeviceManager.cpp, updateBoxDataByJson
  Max4: {
    ...qSeries,
    auxFans: [
      'fan_generic auxiliary_cooling_fan',
      'fan_generic auxiliary_cooling_fan2',
    ],
    box: 'multi_color_controller',
  },
  'X-Max 3': standardFanOnly,
  // QIDITECH/QIDI_PLUS3@d090d42fb20c679726bd519d2e89a55a7faa1051
  // src/mks_printer.cpp comments map the three named fans to output pins
  // fan0/fan2/fan3 and `heater_generic chamber` to `heater_generic hot`.
  'X-Plus 3': {
    partFan: 'output_pin fan0',
    auxFans: ['output_pin fan2'],
    chamberFan: 'output_pin fan3',
    chamberHeater: 'heater_generic hot',
  },
  'X-Smart 3': standardFanOnly,
}
