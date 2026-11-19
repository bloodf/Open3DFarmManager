<script setup lang="ts">
import { computed } from 'vue'
import { type FarmKeyState } from '../../utils/farm-view.ts'
const props = defineProps<{ keys: FarmKeyState; connectionNotice: string }>()
const emit = defineEmits<{ select: [keyId: string] }>()
const keyText = computed(() => {
  const keys = props.keys
  if (!keys || keys.kind === 'available') return ''
  if (keys.kind === 'loading')
    return 'Consultando os dispositivos deste navegador…'
  switch (keys.reason) {
    case 'storage':
      return 'Não foi possível acessar as chaves salvas neste navegador.'
    case 'registry':
      return 'Não foi possível confirmar a aprovação dos dispositivos.'
    case 'incomplete':
      return 'A consulta dos dispositivos ficou incompleta. Nenhum dispositivo foi selecionado.'
    case 'pending':
      return 'O dispositivo deste navegador aguarda aprovação.'
    case 'revoked':
      return 'O dispositivo deste navegador foi revogado.'
    case 'missing':
      return 'Nenhuma chave local corresponde a um dispositivo aprovado desta conta e farm.'
  }
})
function chooseKey(event: Event) {
  if (event.target instanceof HTMLSelectElement)
    emit('select', event.target.value)
}
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
      <select id="farm-device" :value="keys.selected" @change="chooseKey">
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

<style scoped src="./farm-view.css"></style>
