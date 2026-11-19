<script setup lang="ts">
defineProps<{
  label: string
  stops: readonly { label: string; color: string }[]
}>()
</script>

<template>
  <figure class="scale">
    <figcaption>{{ label }}</figcaption>
    <p v-if="!stops.length">Sem faixas para exibir.</p>
    <ol v-else>
      <li v-for="(stop, i) in stops" :key="i">
        <svg
          viewBox="0 0 24 8"
          preserveAspectRatio="none"
          width="24"
          height="8"
          aria-hidden="true"
        >
          <rect width="24" height="8" :fill="stop.color" />
        </svg>
        {{ stop.label }}
      </li>
    </ol>
  </figure>
</template>

<style scoped>
.scale {
  margin: 0;
}
ol {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  padding: 0;
  list-style: none;
}
li {
  display: grid;
  gap: 0.25rem;
}
svg {
  width: 100%;
}
</style>
