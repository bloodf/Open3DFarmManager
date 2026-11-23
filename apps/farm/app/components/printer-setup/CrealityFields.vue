<script setup lang="ts">
import { CREALITY_SUPPORT_NOTE } from '../../utils/creality-onboarding.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const { crealityHost } = usePrinterSetup()
const { selectCrealityMoonraker } = usePrinterSetupActions()
</script>

<template>
  <label for="creality-host">Endereço IPv4 da Creality na LAN</label>
  <input
    id="creality-host"
    v-model="crealityHost"
    required
    maxlength="15"
    inputmode="decimal"
    autocomplete="off"
    spellcheck="false"
    aria-describedby="creality-host-help"
  />
  <p id="creality-host-help">
    Ex.: 192.168.1.60. Firmware original, porta 9999. Sem URL ou credenciais.
  </p>
  <p>{{ CREALITY_SUPPORT_NOTE }}</p>
  <button type="button" @click="selectCrealityMoonraker">
    Minha Creality usa Klipper / Moonraker
  </button>
</template>

<style scoped src="./printer-setup.css"></style>
