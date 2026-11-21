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
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-tight);
  overflow-wrap: anywhere;
}
h3 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--font-size-base);
}
p,
ul {
  margin: 0;
}
.note {
  margin-bottom: var(--space-3);
  color: var(--color-text-muted);
}
ul {
  padding-inline-start: var(--space-5);
}
li,
dd {
  overflow-wrap: anywhere;
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0;
}
.facts div {
  min-width: 0;
}
dt {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
dd {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
a:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
@media (max-width: 30rem) {
  .product {
    padding: var(--space-4);
  }
}
</style>
