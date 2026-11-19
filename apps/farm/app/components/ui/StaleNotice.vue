<script setup lang="ts">
withDefaults(
  defineProps<{
    title?: string
    description?: string
    /** `alert` for a failure the user just caused; `null` for a ticking age. */
    role?: 'status' | 'alert' | null
  }>(),
  { role: 'status' },
)
</script>

<template>
  <div class="stale" :role="role ?? undefined">
    <strong>{{ title ?? 'Dados desatualizados' }}</strong>
    <span v-if="description"> {{ description }}</span>
    <slot />
  </div>
</template>

<style scoped>
.stale {
  padding: var(--space-3, 0.75rem);
  border-radius: var(--radius-sm);
  border: 1px solid var(--printer-warning, currentColor);
  background: var(--surface-raised);
}
</style>
