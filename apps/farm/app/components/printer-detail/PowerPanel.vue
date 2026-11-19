<script setup lang="ts">
defineProps<{
  devices?: readonly {
    name: string
    status: 'on' | 'off' | 'unknown'
    locked: boolean
  }[]
  canCommand: boolean
  reason?: string
}>()

const emit = defineEmits<{
  toggle: [args: { device: string; on: boolean }, event: Event]
}>()

const labels = {
  on: 'Ligado',
  off: 'Desligado',
  unknown: 'Estado desconhecido',
}
</script>

<template>
  <fieldset :disabled="!canCommand">
    <legend>Energia</legend>
    <p v-if="!canCommand && reason">{{ reason }}</p>
    <p v-if="!devices?.length">Nenhum dispositivo de energia disponível.</p>
    <ul v-else>
      <li v-for="device in devices" :key="device.name">
        {{ device.name }} — {{ labels[device.status] }}
        <span v-if="device.locked"> (bloqueado)</span>
        <button
          v-else-if="device.status !== 'unknown'"
          type="button"
          @click="
            emit(
              'toggle',
              { device: device.name, on: device.status === 'off' },
              $event,
            )
          "
        >
          {{ device.status === 'off' ? 'Ligar' : 'Desligar' }} {{ device.name }}
        </button>
      </li>
    </ul>
  </fieldset>
</template>
