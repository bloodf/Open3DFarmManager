<script setup lang="ts">
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const { kobraIp } = usePrinterSetup()
</script>

<template>
  <label for="kobra-ip">Endereço IPv4 da Kobra X na LAN</label>
  <input
    id="kobra-ip"
    v-model="kobraIp"
    required
    maxlength="15"
    autocomplete="off"
    spellcheck="false"
    aria-describedby="kobra-x-intro kobra-ip-help"
  />
  <p id="kobra-ip-help">Informe um IPv4 privado na LAN (ex.: 192.168.1.50).</p>
</template>

<style scoped src="./printer-setup.css"></style>
