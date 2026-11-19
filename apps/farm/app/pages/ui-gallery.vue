<script setup lang="ts">
import { ref } from 'vue'
import Button from '../components/ui/Button.vue'
import Card from '../components/ui/Card.vue'
import ColorScaleLegend from '../components/ui/charts/ColorScaleLegend.vue'
import ProgressRing from '../components/ui/charts/ProgressRing.vue'
import Sparkline from '../components/ui/charts/Sparkline.vue'
import DataTable from '../components/ui/DataTable.vue'
import Dialog from '../components/ui/Dialog.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import Field from '../components/ui/Field.vue'
import Icon from '../components/ui/Icon.vue'
import IconButton from '../components/ui/IconButton.vue'
import Meter from '../components/ui/Meter.vue'
import ProgressBar from '../components/ui/ProgressBar.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import StaleNotice from '../components/ui/StaleNotice.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import Tabs from '../components/ui/Tabs.vue'
import Toast from '../components/ui/Toast.vue'
import {
  formatDateTime,
  formatDuration,
  formatPercentage,
  formatTemperature,
  formatWeight,
} from '../utils/ui-format.ts'

const dialogOpen = ref(false)
const selectedTab = ref('jobs')
const message = ref('')
const tabs = [
  { id: 'jobs', label: 'Impressões' },
  { id: 'materials', label: 'Materiais' },
]
const columns = [
  { id: 'name', label: 'Arquivo' },
  { id: 'status', label: 'Estado' },
]
const start = Date.UTC(2026, 10, 19, 12)
const trend = [201, 205, 209, 212, 214, 215].map((value, i) => ({
  time: start + i * 60_000,
  value,
}))
const scale = [
  { label: '-0,120 mm', color: 'rgb(68, 1, 84)' },
  { label: '0,000 mm', color: 'rgb(33, 144, 141)' },
  { label: '0,120 mm', color: 'rgb(253, 231, 37)' },
]
const rows = [
  { id: 'support', cells: { name: 'suporte.gcode', status: 'Em impressão' } },
]
</script>

<template>
  <main class="gallery">
    <h1>Galeria de componentes</h1>
    <Card>
      <h2>Impressora</h2>
      <StatusBadge tone="printing" label="Em impressão" />
      <ProgressBar label="Progresso da impressão" :value="42" />
      <Meter label="Filamento restante" :value="68" />
      <Button @click="dialogOpen = true">Ver detalhes</Button>
      <IconButton
        icon="refresh"
        label="Atualizar estado"
        @click="message = 'Estado atualizado.'"
      />
      <Toast :message="message" />
      <Dialog v-model="dialogOpen" title="Detalhes da impressão">
        <p>O arquivo suporte.gcode está em impressão.</p>
      </Dialog>
    </Card>

    <Card>
      <h2>Gráficos e formatos</h2>
      <ProgressRing label="Progresso do trabalho" :value="42" />
      <Sparkline label="Tendência da temperatura do bico" :points="trend" />
      <ColorScaleLegend label="Escala de cores da malha" :stops="scale" />
      <dl>
        <dt>Início</dt>
        <dd>{{ formatDateTime(start) }}</dd>
        <dt>Duração</dt>
        <dd>{{ formatDuration(5_400) }}</dd>
        <dt>Bico</dt>
        <dd>{{ formatTemperature(215.04) }}</dd>
        <dt>Filamento</dt>
        <dd>{{ formatWeight(742.5) }}</dd>
        <dt>Progresso</dt>
        <dd>{{ formatPercentage(42) }}</dd>
      </dl>
    </Card>

    <Card>
      <Tabs v-model="selectedTab" label="Dados da impressora" :tabs="tabs">
        <template #jobs>
          <DataTable
            caption="Fila de impressão"
            :columns="columns"
            :rows="rows"
          />
        </template>
        <template #materials>
          <EmptyState
            title="Nenhum material cadastrado"
            description="Cadastre um material para acompanhar o estoque de filamento."
          >
            <Button @click="message = 'Cadastro de material iniciado.'">
              Cadastrar material
            </Button>
          </EmptyState>
        </template>
      </Tabs>
    </Card>

    <Card>
      <h2>Identificação</h2>
      <Field
        label="Nome da impressora"
        hint="Use um nome curto para identificar a impressora."
      >
        <template #default="{ control }">
          <input v-bind="control" type="text" />
        </template>
      </Field>
    </Card>
    <Card>
      <h2>Carregando histórico</h2>
      <div aria-busy="true">
        <p role="status">Carregando histórico…</p>
        <Skeleton />
        <Skeleton />
      </div>
    </Card>
    <StaleNotice
      title="Histórico desatualizado"
      description="Não foi possível atualizar. Mostrando os últimos dados carregados."
    >
      <Button @click="message = 'Atualizando o histórico.'">
        <Icon name="refresh" />
        Atualizar
      </Button>
    </StaleNotice>
    <ErrorState
      title="Histórico indisponível"
      description="Tente carregar o histórico novamente."
    >
      <Button @click="message = 'O histórico continua indisponível.'">
        <Icon name="refresh" />
        Tentar novamente
      </Button>
    </ErrorState>
  </main>
</template>

<style scoped>
.gallery {
  display: grid;
  gap: var(--space-4);
}
</style>
