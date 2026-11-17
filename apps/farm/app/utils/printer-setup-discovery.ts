import { discoveryPrefill, discoveryStatus } from './printer-discovery-view.ts'
import type { openPrinterDiscoverySession } from './printer-discovery-view-session.ts'
import type {
  DiscoveredPrinter,
  PrinterSetupRefs,
} from './printer-setup-state.ts'

// The session opener is injected so the page owns the transport it uses.
export function createPrinterDiscovery(
  state: PrinterSetupRefs,
  controller: () => AbortController | undefined,
  closeKobraSession: () => void,
  openSession: typeof openPrinterDiscoverySession,
) {
  const {
    farmId,
    kobraAgentId,
    kobraKeyState,
    kobraBootstrap,
    selectedKobraKey,
    kobraLabel,
    onboardingFamily,
    bambuIp,
    bambuSerial,
    bambuAccessCode,
    moonrakerOrigin,
    moonrakerApiKey,
    moonrakerUsername,
    moonrakerPassword,
    crealityHost,
    anycubicHost,
    anycubicUsername,
    anycubicPassword,
    discoveryPrinters,
    discoveryMessage,
    discoveryBusy,
  } = state

  async function searchPrinters(host?: string) {
    if (discoveryBusy.value) return
    const key = selectedKobraKey.value
    const state = kobraKeyState.value
    const boot = kobraBootstrap.value
    const active = controller()
    if (!key || state.kind !== 'available' || boot.kind !== 'ready' || !active)
      return
    const signal = active.signal
    discoveryBusy.value = true
    discoveryPrinters.value = []
    discoveryMessage.value = 'Procurando impressoras…'
    let session: Awaited<ReturnType<typeof openSession>> | undefined
    try {
      session = await openSession({
        accountId: state.accountId,
        farmId: farmId.value,
        agentId: kobraAgentId.value,
        keyId: key.keyId,
        localKey: key.localKey,
        bootstrap: boot.data,
        signal,
      })
      const result = await session.discover(signal, host)
      if (signal.aborted) return
      discoveryMessage.value = discoveryStatus(result)
      if (result.ok) {
        discoveryPrinters.value = result.printers
        if (host && result.printers[0]) selectDiscovery(result.printers[0])
      }
    } catch {
      if (!signal.aborted)
        discoveryMessage.value =
          'Não foi possível procurar impressoras. Tente novamente.'
    } finally {
      session?.close()
      discoveryBusy.value = false
    }
  }

  function selectDiscovery(printer: DiscoveredPrinter) {
    const prefill = discoveryPrefill(printer)
    closeKobraSession()
    onboardingFamily.value = prefill.family
    kobraLabel.value = prefill.label
    switch (prefill.family) {
      case 'bambu-lan':
        bambuIp.value = prefill.ip
        bambuSerial.value = prefill.serial
        bambuAccessCode.value = ''
        break
      case 'klipper-moonraker':
        moonrakerOrigin.value = prefill.origin
        moonrakerApiKey.value = ''
        moonrakerUsername.value = ''
        moonrakerPassword.value = ''
        break
      case 'creality-native':
        crealityHost.value = prefill.host
        break
      case 'anycubic-lan':
        anycubicHost.value = prefill.host
        anycubicUsername.value = ''
        anycubicPassword.value = ''
        break
      default: {
        const _exhaustive: never = prefill
        return _exhaustive
      }
    }
  }

  return { searchPrinters, selectDiscovery }
}
