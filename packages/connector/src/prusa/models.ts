import type { PrusaLinkBinding } from './config.ts'

// Per-model PrusaLink bindings. Source-derived only: every model stays
// unqualified until hardware checks. Evidence and gaps:
// docs/fullfarmmanager/evidence/prusa.md
//
// Buddy printer types: GET /api/version formats `printer` as
// type.version.subversion of the current model.
// prusa3d/Prusa-Firmware-Buddy @ b1043d68be188ad27ea72a14e160140e30e589f0 (v8.0.2)
//   lib/WUI/link_content/basic_gets.cpp (get_version)
//   include/common/printer_model_data.hpp (printer_model_info)
//   src/common/printer_variant/{coreone,coreonel}.hpp ("+" editions are
//   variants of one model, so they report the same tuple)
//
// Raspberry Pi PrusaLink (MK2.5 and MK3 families) reports no `printer` field.
// prusa3d/Prusa-Link @ 58a0ab1703680c32d39c76684e906c8f2ea91464 and tag 0.8.1
//   (31e85687953b7b91c14ba8522293cd135f4c39ba), prusa/link/web/main.py
//   (api_version)

export type PrusaLinkModel = Readonly<{
  /** Catalog model name. */
  model: string
  host: 'buddy' | 'pi-prusalink'
  /**
   * Buddy has no camera route in lib/WUI (same commit as above). Pi PrusaLink
   * serves /api/v1/cameras/snap in prusa/link/web/cameras.py.
   */
  camera: 'no-route' | 'documented'
  binding:
    | Readonly<{
        status: 'bindable'
        /** Exact `GET /api/version` `printer` string. */
        printerType: string
        /**
         * Earliest stable release found whose notes list the model and whose
         * tagged basic_gets.cpp emits `printer`. Older firmware fails the
         * identity check. This is not a qualified operating minimum.
         */
        identityFirmware: string
      }>
    | Readonly<{ status: 'refused'; reason: 'no-wire-model-identity' }>
}>

function buddy(
  model: string,
  printerType: string,
  identityFirmware: string,
): PrusaLinkModel {
  return Object.freeze({
    model,
    host: 'buddy',
    camera: 'no-route',
    binding: Object.freeze({
      status: 'bindable',
      printerType,
      identityFirmware,
    }),
  })
}

function pi(model: string): PrusaLinkModel {
  return Object.freeze({
    model,
    host: 'pi-prusalink',
    camera: 'documented',
    binding: Object.freeze({
      status: 'refused',
      reason: 'no-wire-model-identity',
    }),
  })
}

export const PRUSA_LINK_MODELS: readonly PrusaLinkModel[] = Object.freeze([
  buddy('Prusa CORE One', '7.1.0', '6.5.3'),
  buddy('Prusa CORE One+', '7.1.0', '6.5.3'),
  buddy('Prusa CORE One L', '8.1.0', '6.5.1'),
  buddy('Prusa XL', '3.1.0', '6.10.1'),
  buddy('Prusa MK4', '1.4.0', '6.5.3'),
  buddy('Prusa MK4S', '1.4.1', '6.5.3'),
  buddy('Prusa MK3.9', '1.3.9', '6.5.3'),
  buddy('Prusa MK3.9S', '1.3.10', '6.5.3'),
  buddy('Prusa MK3.5', '1.3.5', '6.5.3'),
  buddy('Prusa MK3.5S', '1.3.6', '6.5.3'),
  buddy('Prusa MINI', '2.1.0', '7.0.0'),
  buddy('Prusa MINI+', '2.1.0', '7.0.0'),
  pi('Prusa MK2.5'),
  pi('Prusa MK2.5S'),
  pi('Prusa MK3'),
  pi('Prusa MK3S'),
  pi('Prusa MK3S+'),
])

/**
 * Builds the Connector v8 driver entry for a catalog model. Models that share a
 * printer type (CORE One and One+, MINI and MINI+) get identical identity
 * checks: the wire cannot tell them apart.
 */
export function prusaLinkBinding(input: {
  model: string
  printerKey: string
  origin: string
  apiKeyFile: string
  serial: string
}): PrusaLinkBinding {
  const { model, printerKey, origin, apiKeyFile, serial } = input
  const entry = PRUSA_LINK_MODELS.find((value) => value.model === model)
  if (!entry) throw new Error(`Unknown PrusaLink model: ${model}`)
  if (entry.binding.status === 'refused')
    throw new Error(
      `PrusaLink binding refused for ${model}: ${entry.binding.reason}`,
    )
  return {
    family: 'prusa-link',
    printerKey,
    origin,
    apiKeyFile,
    expect: { serial, printerType: entry.binding.printerType },
  }
}
