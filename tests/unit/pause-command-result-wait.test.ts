import { describe, expect, it } from 'vitest'
import {
  pauseCommandResultWaitMs,
  pauseResultDriverFamilyFromIdentity,
} from '../../apps/farm/app/utils/webrtc/pause-command-client.ts'

describe('pause command result wait by driver family', () => {
  it.each([
    [{ vendor: 'Klipper', model: 'Moonraker' }, 'moonraker', 5_000],
    [{ vendor: 'Snapmaker', model: 'U1' }, 'u1', 29_000],
    [{ vendor: 'Anycubic', model: 'Kobra X' }, 'kobra-x', 29_000],
    [{ vendor: 'Bambu Lab', model: 'X1 Carbon' }, 'bambu', 5_000],
    [undefined, 'unknown', 5_000],
  ] as const)(
    'uses the Connector identity family for %s',
    (identity, family, wait) => {
      expect(pauseResultDriverFamilyFromIdentity(identity)).toBe(family)
      expect(pauseCommandResultWaitMs(family)).toBe(wait)
    },
  )
})
