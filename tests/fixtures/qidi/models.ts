// Vendor configurations document the named part fan on these four variants.
// https://github.com/QIDITECH/QIDI_Q1_Pro/blob/main/config/printer.cfg
// https://github.com/QIDITECH/QIDI_PLUS4/blob/main/config/printer.cfg
// https://github.com/QIDITECH/QIDI_Q2/blob/main/config/printer.cfg
// https://github.com/QIDITECH/QIDI_MAX4/blob/main/config/printer.cfg
// The X-series vendor repositories document the Moonraker fork. Fan mapping
// stays unknown in these fixtures pending an installed configuration.
export const qidiModels = [
  { name: 'Q1 Pro', namedFan: true },
  { name: 'Plus4', namedFan: true },
  { name: 'Q2', namedFan: true },
  { name: 'Max4', namedFan: true },
  { name: 'X-Max 3', namedFan: false },
  { name: 'X-Plus 3', namedFan: false },
  { name: 'X-Smart 3', namedFan: false },
]
