<script setup lang="ts">
import type { NuxtError } from '#app'
import ErrorScreen from './components/errors/ErrorScreen.vue'
import { errorCopy } from './components/errors/error-copy.ts'

const props = defineProps<{ error: NuxtError }>()

useHead({
  title: computed(
    () => `${errorCopy(props.error.statusCode).title} · Open3DFarmManager`,
  ),
})

// Clearing the error renders the app again; a redirect leaves the failed route.
function recover(to: string | undefined) {
  void clearError(to ? { redirect: to } : undefined)
}
</script>

<template>
  <NuxtLayout>
    <ErrorScreen :status-code="error.statusCode" @recover="recover" />
  </NuxtLayout>
</template>
