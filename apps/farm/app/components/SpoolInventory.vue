<script setup lang="ts">
import { computed } from 'vue'
import {
  spoolInventoryStale,
  type FarmRow,
  type FarmSpoolObservation,
} from '../utils/farm-view.ts'

// Read-only Spoolman mirror received over the browser-to-Connector channel.
const props = defineProps<{
  items: readonly FarmSpoolObservation[]
  now: { wall: number; mono: number }
  connected: boolean
  rows: readonly FarmRow[]
}>()
const sections = computed(() =>
  props.items.map((item) => {
    const seconds = Math.floor((props.now.mono - item.received.mono) / 1000)
    const names = props.rows
      .filter((row) => row.assignment.agentId === item.agentId)
      .map((row) => row.assignment.printerKey)
    return {
      item,
      label: names.length
        ? `Connector das impressoras ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` e mais ${names.length - 3}` : ''}`
        : 'Connector',
      stale: spoolInventoryStale(item, props.now),
      age:
        Number.isFinite(seconds) && seconds >= 0
          ? seconds >= 86_400
            ? 'Atualização recebida há mais de 24 h'
            : `Atualização recebida há ${seconds} s`
          : 'Horário de recebimento não confirmado',
    }
  }),
)
function grams(value: number | null) {
  return value === null ? 'Indisponível' : `${value.toLocaleString('pt-BR')} g`
}
</script>
<template>
  <section aria-labelledby="spools-heading" class="spools">
    <h2 id="spools-heading">Estoque de filamento</h2>
    <p>Somente leitura. Os dados vêm do Spoolman, pelo Connector.</p>
    <div role="status">
      <p v-if="!sections.length">
        {{
          connected
            ? 'Aguardando o estoque informado pelo Connector.'
            : 'Estoque indisponível sem conexão direta com o Connector.'
        }}
      </p>
    </div>
    <div v-for="section in sections" :key="section.item.agentId">
      <h3 class="opaque">{{ section.label }}</h3>
      <div role="status">
        <p v-if="!section.item.inventory">
          Estoque indisponível. O Connector não informou dados do Spoolman neste
          momento.
        </p>
        <p v-else>
          <strong v-if="section.stale">Desatualizado.</strong>
          {{ section.age }}.
        </p>
      </div>
      <template v-if="section.item.inventory">
        <p v-if="section.item.inventory.total === 0">
          Nenhuma bobina cadastrada no Spoolman.
        </p>
        <p v-else-if="!section.item.inventory.spools.length">
          Exibindo 0 de {{ section.item.inventory.total }} bobinas. O Connector
          não pôde enviar o detalhe. Consulte o Spoolman.
        </p>
        <div
          v-else
          class="scroll"
          tabindex="0"
          role="region"
          :aria-label="`Bobinas: ${section.label}`"
        >
          <table>
            <caption>
              Bobinas ({{
                section.item.inventory.spools.length
              }}
              de
              {{
                section.item.inventory.total
              }})
            </caption>
            <thead>
              <tr>
                <th scope="col">Filamento</th>
                <th scope="col">Material</th>
                <th scope="col">Cor</th>
                <th scope="col">Restante</th>
                <th scope="col">Local</th>
                <th scope="col">Situação</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(spool, index) in section.item.inventory.spools"
                :key="index"
              >
                <th scope="row">{{ spool.name ?? 'Sem nome' }}</th>
                <td>{{ spool.material ?? 'Indisponível' }}</td>
                <td>
                  <template v-if="spool.colorHex">
                    <span
                      class="swatch"
                      aria-hidden="true"
                      :style="{ backgroundColor: `#${spool.colorHex}` }"
                    ></span>
                    #{{ spool.colorHex }}
                  </template>
                  <template v-else>Indisponível</template>
                </td>
                <td>{{ grams(spool.remainingGrams) }}</td>
                <td>{{ spool.location ?? 'Sem local' }}</td>
                <td>{{ spool.archived ? 'Arquivada' : 'Ativa' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="
            section.item.inventory.spools.length > 0 &&
            section.item.inventory.total > section.item.inventory.spools.length
          "
        >
          Exibindo parte do estoque. Consulte o Spoolman para a lista completa.
        </p>
      </template>
    </div>
  </section>
</template>
<style scoped>
.spools {
  margin-bottom: 1.5rem;
}
.scroll {
  overflow-x: auto;
  max-width: 100%;
}
table {
  border-collapse: collapse;
  min-width: 100%;
}
caption {
  text-align: left;
  font-weight: 600;
  padding-bottom: 0.5rem;
}
th,
td {
  border: 1px solid currentColor;
  padding: 0.4rem 0.6rem;
  text-align: left;
  overflow-wrap: anywhere;
}
.swatch {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  vertical-align: middle;
  border: 1px solid currentColor;
}
.opaque {
  overflow-wrap: anywhere;
}
</style>
