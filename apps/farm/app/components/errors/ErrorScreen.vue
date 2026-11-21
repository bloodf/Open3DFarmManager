<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Button from '../ui/Button.vue'
import Card from '../ui/Card.vue'
import { errorCopy } from './error-copy.ts'

const props = defineProps<{ statusCode?: number }>()
const emit = defineEmits<{
  recover: [to: string | undefined]
}>()

const copy = errorCopy(props.statusCode)
const heading = ref<HTMLElement | null>(null)

// A route change replaces the whole screen: put the reader on the new heading.
onMounted(() => heading.value?.focus())
</script>

<template>
  <main id="conteudo" class="error-page">
    <Card class="error-card">
      <p class="eyebrow">Open3DFarmManager · Erro {{ copy.code }}</p>
      <h1 ref="heading" tabindex="-1">{{ copy.title }}</h1>
      <p class="description">{{ copy.description }}</p>
      <nav class="actions" aria-label="Como continuar">
        <Button
          v-if="copy.kind === 'server'"
          @click="emit('recover', undefined)"
        >
          Tentar novamente
        </Button>
        <NuxtLink to="/" @click.prevent="emit('recover', '/')">
          Voltar ao início
        </NuxtLink>
        <NuxtLink to="/farm" @click.prevent="emit('recover', '/farm')">
          Minha farm
        </NuxtLink>
        <NuxtLink
          v-if="copy.kind === 'forbidden'"
          to="/entrar"
          @click.prevent="emit('recover', '/entrar')"
        >
          Entrar na conta
        </NuxtLink>
      </nav>
    </Card>
  </main>
</template>

<style scoped>
.error-page {
  display: grid;
  align-content: start;
  gap: var(--space-4);
  padding: var(--space-4);
  max-inline-size: 40rem;
}
.error-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  box-shadow: none;
}
.eyebrow,
.description,
h1 {
  margin: 0;
}
.eyebrow {
  font-size: var(--font-size-sm);
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
h1 {
  overflow-wrap: anywhere;
  line-height: var(--line-height-tight);
}
h1:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
  border-radius: var(--radius-sm);
}
.description {
  color: var(--color-text-muted);
  max-inline-size: 60ch;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  margin-top: var(--space-2);
}
.actions a {
  display: inline-flex;
  align-items: center;
  min-block-size: 2.75rem;
}
@media (max-width: 30rem) {
  .error-page {
    padding: var(--space-3);
  }
  .error-card {
    padding: var(--space-4);
  }
}
</style>
