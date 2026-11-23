<script setup lang="ts">
defineProps<{ message: string }>()
</script>

<template>
  <div role="status" aria-label="Alertas Bambu Lab">
    <p>{{ message || 'Nenhum alerta informado.' }}</p>
  </div>
</template>
