import { signallingSocketHooks } from '../../services/signalling-routes.ts'
export default defineWebSocketHandler(signallingSocketHooks('connector'))
