<script setup lang="ts">
defineProps<{ tool: number; targetC: number }>()
</script>

<template>
  <p id="pause-dialog-description">
    Confirme a temperatura de {{ targetC }} °C para a Ferramenta {{ tool + 1 }}.
    O comando será enviado diretamente ao Connector e não será repetido
    automaticamente.
  </p>
</template>
