<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  unit?: string
  context?: string
}>()
</script>
<template>
  <div class="stat">
    <dt>{{ label }}</dt>
    <dd>
      <span>{{ value }}</span><span v-if="unit">&nbsp;{{ unit }}</span>
    </dd>
    <dd v-if="context" class="context">{{ context }}</dd>
  </div>
</template>
<style scoped>
.stat dt {
  color: var(--ops-muted);
  font: 600 var(--ops-text-label) var(--ops-font-mono);
  text-transform: uppercase;
}
.stat dd {
  margin: 0;
  font: 600 var(--ops-text-value) var(--ops-font-mono);
  font-variant-numeric: tabular-nums;
}
.stat .context {
  color: var(--ops-muted);
  font-size: var(--ops-text-small);
  margin: 0;
}
</style>
