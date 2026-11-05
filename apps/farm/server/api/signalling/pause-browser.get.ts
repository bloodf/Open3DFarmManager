import { signallingSocketHooks } from '../../services/signalling-routes.ts'
export default defineWebSocketHandler(signallingSocketHooks('browser', 'pause'))
