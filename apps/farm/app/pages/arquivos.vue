<script setup lang="ts">
import { ref } from 'vue'
import { validateUpload } from '../utils/files-view.ts'
definePageMeta({ middleware: 'farm-flag' })
const error = ref('')
function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  error.value = file
    ? (validateUpload(file) ??
      'Envio indisponível: sessão de arquivos ainda não conectada.')
    : ''
}
</script>
<template>
  <main>
    <nav aria-label="Navegação da farm">
      <NuxtLink to="/farm">Farm</NuxtLink>
    </nav>
    <h1>Arquivos</h1>
    <p>
      A conexão direta com a impressora é necessária para consultar arquivos e
      iniciar impressão.
    </p>
    <label for="upload">Arquivo .gcode ou .3mf (até 512 MiB)</label>
    <input id="upload" type="file" accept=".gcode,.3mf" @change="selectFile" />
    <p role="status">{{ error }}</p>
  </main>
</template>
