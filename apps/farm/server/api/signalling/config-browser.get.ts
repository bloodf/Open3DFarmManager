import { configurationSocketHooks } from '../../services/configuration-signalling-runtime.ts'
import { configurationSignallingRuntime } from '../../utils/configuration/runtime.ts'
import { databaseServing } from '../../utils/database/phase.ts'

export default defineWebSocketHandler(
  configurationSocketHooks(
    'browser',
    configurationSignallingRuntime,
    databaseServing,
  ),
)
