<script setup lang="ts">
import {
  capabilityLabels,
  capabilityStatusLabels,
  controlAreaKeys,
  controlAreaLabels,
} from '../../utils/compatibility/index'
import type { AnycubicCatalogProduct } from '../../utils/compatibility/anycubic'

// One catalog entry. Labels describe known information and limits; they never
// enable a command.
defineProps<{ product: AnycubicCatalogProduct; klipperFamily: boolean }>()
</script>

<template>
  <section class="product" :aria-labelledby="product.id">
    <h2 :id="product.id">{{ product.brand }} {{ product.model }}</h2>
    <p v-if="klipperFamily" class="note">
      Família Klipper/Moonraker. Simulado indica teste contra simuladores, não
      contra hardware.
    </p>
    <dl class="facts">
      <div>
        <dt>Lançamento</dt>
        <dd>
          {{ product.releaseStatus
          }}<span v-if="product.releaseDate"> ({{ product.releaseDate }})</span>
        </dd>
      </div>
      <div>
        <dt>Firmware</dt>
        <dd>{{ product.firmwareStatus }}</dd>
      </div>
      <div>
        <dt>Conexão</dt>
        <dd>{{ product.connection }}</dd>
      </div>
      <div
        v-for="(status, capability) in product.capabilities"
        :key="capability"
      >
        <dt>{{ capabilityLabels[capability] }}</dt>
        <dd>{{ capabilityStatusLabels[status] }}</dd>
      </div>
    </dl>
    <h3>Áreas de controle</h3>
    <dl class="facts">
      <div v-for="area in controlAreaKeys" :key="area">
        <dt>{{ controlAreaLabels[area] }}</dt>
        <dd>{{ capabilityStatusLabels[product.controlAreas[area]] }}</dd>
      </div>
    </dl>
    <template v-if="product.firmwareNotes?.length">
      <h3>Notas de firmware</h3>
      <ul>
        <li v-for="(entry, index) in product.firmwareNotes" :key="index">
          {{ entry.firmware }}: {{ entry.note }}
        </li>
      </ul>
    </template>
    <h3>Limitações</h3>
    <ul>
      <li v-for="limit in product.limitations" :key="limit">{{ limit }}</li>
    </ul>
    <h3>Fontes</h3>
    <ul>
      <li v-for="(source, index) in product.sources" :key="source">
        <a :href="source">Fonte {{ index + 1 }} para {{ product.model }}</a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.product {
  min-width: 0;
}
h2 {
  margin: 0;
}
h3 {
  margin: var(--ops-space-2) 0 0;
  padding-block-start: var(--ops-space-3);
  border-block-start: 1px solid var(--ops-border);
}
p,
ul {
  margin: 0;
}
.note {
  color: var(--ops-muted);
}
ul {
  padding-inline-start: var(--ops-space-5);
}
li,
dd {
  overflow-wrap: anywhere;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr));
  gap: var(--ops-space-3) var(--ops-space-4);
  margin: 0;
}
.facts div {
  display: grid;
  align-content: start;
  gap: var(--ops-space-1);
  min-width: 0;
}
dd {
  margin: 0;
  font-weight: 600;
}
li a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
}
a:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
</style>
