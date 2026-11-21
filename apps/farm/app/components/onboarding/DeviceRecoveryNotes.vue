<script setup lang="ts">
// Static explanation of proof deadlines, loss and recovery of a browser key.
import OnboardingPanel from './OnboardingPanel.vue'
</script>

<template>
  <OnboardingPanel
    heading-id="recovery-heading"
    title="Posse, perda e recuperação"
  >
    <p>
      Cada prova deve terminar em 60 segundos. Um pedido pendente dura 24 horas
      desde a criação. Confirmar novamente a posse não renova esse prazo. Cada
      chave admite somente três desafios durante toda sua existência, incluindo
      falhas, expiração e recuperações bem-sucedidas. Não há renovação
      automática desse limite.
    </p>
    <p>
      Em um novo login, a mesma chave pode confirmar sua posse novamente,
      respeitando esses limites e a autorização atual. Uma chave revogada não
      pode ser recuperada. A aprovação exige proprietário ou administrador atual
      e acesso válido do titular.
    </p>
    <p>
      A chave privada não pode ser exportada e permanece no IndexedDB deste
      navegador. Limpar dados, trocar de navegador ou perder este armazenamento
      pode perder a chave. Não há cópia de segurança nem substituição
      automática. Chaves antigas continuam registradas até revogação explícita
      por proprietário ou administrador.
    </p>
    <p>
      Este cadastro não emite sessão de transporte e não oferece comandos,
      sinalização ou conexão com Connector.
    </p>
  </OnboardingPanel>
</template>
