<script setup lang="ts">
import type { FarmKeyState } from '../../utils/farm-view.ts'

defineProps<{
  connectionNotice: string
  keys: FarmKeyState
  keyText: string
}>()

const emit = defineEmits<{
  changeKey: [event: Event]
}>()
</script>

<template>
  <section aria-label="Conexão e dispositivo do navegador">
    <p role="status">{{ connectionNotice }}</p>
    <p v-if="keys.kind !== 'available'">
      Este navegador precisa de um dispositivo aprovado para receber o estado.
      {{ keyText }}
    </p>
    <template v-else>
      <label for="farm-device">Dispositivo aprovado deste navegador</label>
      <select
        id="farm-device"
        :value="keys.selected"
        @change="emit('changeKey', $event)"
      >
        <option value="">Selecione um dispositivo</option>
        <option v-for="key in keys.choices" :key="key.keyId" :value="key.keyId">
          {{ key.keyId }} · {{ key.thumbprint }}
        </option>
      </select>
      <p>A aprovação do dispositivo não confirma uma conexão direta.</p>
    </template>
    <NuxtLink to="/dispositivos">Gerenciar dispositivos do navegador</NuxtLink>
  </section>
</template>
