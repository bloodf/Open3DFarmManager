<script setup lang="ts">
import ProgressRing from '../components/ui/charts/ProgressRing.vue'
import Sparkline from '../components/ui/charts/Sparkline.vue'
import ColorScaleLegend from '../components/ui/charts/ColorScaleLegend.vue'
import { formatTemperature } from '../utils/ui-format.ts'
import { ref } from 'vue'
import Button from '../components/ui/Button.vue'
import Card from '../components/ui/Card.vue'
import Stat from '../components/ui/Stat.vue'
import PageHeader from '../components/ui/PageHeader.vue'
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
import FarmLevel from '../components/spool-art/FarmLevel.vue'
import FarmSlot from '../components/spool-art/FarmSlot.vue'
import FarmSpool from '../components/spool-art/FarmSpool.vue'

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
const rows = [
  { id: 'support', cells: { name: 'suporte.gcode', status: 'Em impressão' } },
]
</script>

<template>
  <main class="gallery">
    <PageHeader
      title="Galeria de componentes"
      description="Elementos compartilhados para operações."
    />
    <Card>
      <h2>Estados e indicadores</h2>
      <div class="statuses">
        <StatusBadge tone="printing" label="Em impressão" />
        <StatusBadge tone="attention" label="Precisa de atenção" />
        <StatusBadge tone="fault" label="Falha" />
        <StatusBadge tone="maintenance" label="Manutenção programada" />
        <StatusBadge tone="idle" label="Ociosa" />
        <StatusBadge tone="offline" label="Desconectada" />
        <StatusBadge tone="stale" label="Dados desatualizados" />
      </div>
      <dl>
        <Stat
          label="Impressoras em operação"
          :value="12"
          unit="impressoras"
          context="Atualizado agora"
        />
      </dl>
      <EmptyState
        title="Nenhum trabalho na fila"
        description="Adicione um trabalho para começar."
      />
    </Card>
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
      <h2>Gráficos</h2>
      <ProgressRing label="Progresso informado da impressão" :value="42.5" />
      <p>Temperatura da mesa: {{ formatTemperature(61.5) }}</p>
      <Sparkline
        label="Tendência de temperatura da mesa"
        :points="[
          { time: 0, value: 58 },
          { time: 1000, value: 61.5 },
        ]"
      />
      <ColorScaleLegend
        label="Escala de altura da malha"
        :stops="[
          { label: '−0,2 mm', color: '#28347a' },
          { label: '0,2 mm', color: '#ffdb59' },
        ]"
      />
    </Card>

    <Card>
      <section
        class="spool-art"
        data-testid="spool-art-gallery"
        aria-labelledby="spool-art-title"
      >
        <h2 id="spool-art-title">Carretéis e slots</h2>
        <p>
          O nível vem do Spoolman, depois da porcentagem informada pela
          impressora. Sem nenhum dos dois, o carretel aparece cheio com o aviso
          “desconhecido”.
        </p>
        <h3>Carretel</h3>
        <ul class="spool-art-row" aria-label="Níveis do carretel">
          <li>
            <FarmSpool color="#c0392b" :fraction="1" :size="64" />
            <span>Cheio</span>
          </li>
          <li>
            <FarmSpool color="#2e86c1" :fraction="0.55" :size="64" />
            <span>55 %</span>
          </li>
          <li>
            <FarmSpool color="#27ae60" :fraction="0.08" :size="64" />
            <span>Quase vazio</span>
          </li>
          <li>
            <FarmSpool color="#c0392b" :fraction="0" :size="64" />
            <span>Vazio</span>
          </li>
          <li>
            <FarmSpool color="#f1c40f" :size="64" />
            <span>Nível desconhecido</span>
          </li>
          <li>
            <FarmSpool :fraction="0.7" :size="64" />
            <span>Cor não informada</span>
          </li>
          <li>
            <FarmSpool
              :colors="['#c0392b', '#f1c40f', '#2e86c1']"
              :fraction="0.7"
              :size="64"
            />
            <span>Multicolor</span>
          </li>
        </ul>
        <h3>Barra de nível</h3>
        <ul class="spool-art-levels" aria-label="Tons da barra de nível">
          <li>
            <span>Normal, 80 %</span>
            <FarmLevel :fraction="0.8" label="Nível normal, 80 %" />
          </li>
          <li>
            <span>Baixo, 12 %</span>
            <FarmLevel :fraction="0.12" tone="low" label="Nível baixo, 12 %" />
          </li>
          <li>
            <span>Crítico, 3 %</span>
            <FarmLevel
              :fraction="0.03"
              tone="critical"
              label="Nível crítico, 3 %"
            />
          </li>
          <li>
            <span>Desconhecido</span>
            <FarmLevel label="Nível desconhecido" />
          </li>
        </ul>
        <h3>Slot da impressora</h3>
        <div class="spool-art-slots">
          <FarmSlot
            label="AMS 1 · A1"
            name="PLA Vermelho"
            material="PLA"
            color="#c0392b"
            color-name="Vermelho"
            :spoolman-remaining-weight="820"
            :spoolman-initial-weight="1000"
            :printer-percent="90"
            active
          />
          <FarmSlot
            label="AMS 1 · A2"
            name="PETG Azul"
            material="PETG"
            color="#2e86c1"
            color-name="Azul"
            :printer-percent="40"
          />
          <FarmSlot
            label="AMS 1 · A3"
            name="PLA Preto"
            material="PLA"
            color="#202020"
            color-name="Preto"
            :spoolman-remaining-weight="90"
            :spoolman-initial-weight="1000"
            low
          />
          <FarmSlot label="AMS 1 · A4" />
          <FarmSlot
            label="Slot externo"
            name="TPU Amarelo"
            material="TPU"
            color="#f1c40f"
            color-name="Amarelo"
          />
          <FarmSlot
            label="ACE 1 · 2"
            name="ABS"
            material="ABS"
            :printer-percent="60"
          />
        </div>
      </section>
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
.statuses {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ops-space-2);
}
.spool-art > h3 {
  margin: var(--ops-space-4) 0 var(--ops-space-2);
  font-size: var(--ops-text-body);
}
.spool-art-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ops-space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}
.spool-art-row li {
  display: grid;
  justify-items: center;
  gap: var(--ops-space-2);
  font-size: var(--ops-text-small);
}
.spool-art-levels {
  display: grid;
  gap: var(--ops-space-3);
  max-inline-size: 320px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.spool-art-levels li {
  display: grid;
  gap: var(--ops-space-1);
  font-size: var(--ops-text-small);
}
.spool-art-slots {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: var(--ops-space-3);
}
.gallery {
  display: grid;
  gap: var(--space-4);
}
</style>
