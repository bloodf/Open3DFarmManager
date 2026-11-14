import { positiveWorld } from '../../e2e/kobralink-rtc.spec.ts'
import type { WorldContext } from './acceptance.ts'
import type { World } from './qualification.ts'
import {
  accountSwitchWorld,
  authorityWorld,
  credentialExpiryWorld,
} from './worlds-authority.ts'
import {
  lateAckWorld,
  lostReplyWorld,
  thinkTimeWorld,
} from './worlds-recovery.ts'

const RUNNERS: Readonly<Record<World, (ctx: WorldContext) => Promise<void>>> = {
  positive: positiveWorld,
  'think-time': thinkTimeWorld,
  'lost-reply': lostReplyWorld,
  'late-ack': lateAckWorld,
  authority: authorityWorld,
  'account-switch': accountSwitchWorld,
  'credential-expiry': credentialExpiryWorld,
}

export function worldRunner(world: World) {
  return RUNNERS[world]
}
