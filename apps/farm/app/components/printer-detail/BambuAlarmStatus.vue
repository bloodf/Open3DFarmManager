<script setup lang="ts">
defineProps<{ message: string }>()
</script>

<template>
  <section class="bambu-alarm" aria-labelledby="bambu-alarm-title">
    <h2 id="bambu-alarm-title">Alertas da impressora</h2>
    <p
      role="status"
      aria-label="Alertas Bambu Lab"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ message || 'Nenhum alerta informado.' }}
    </p>
  </section>
</template>

<style scoped>
.bambu-alarm {
  margin-block-end: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-inline-start: 0.25rem solid var(--state-error-color);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
}

.bambu-alarm h2 {
  margin: 0;
  font-size: var(--font-size-lg);
}

.bambu-alarm p {
  margin: var(--space-1) 0 0;
}
</style>
