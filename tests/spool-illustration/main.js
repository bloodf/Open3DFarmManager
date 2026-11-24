import { createApp } from 'vue/dist/vue.esm-bundler.js'
import SpoolIllustration from '../../apps/farm/app/components/spool-library/SpoolIllustration.vue'
import '../../apps/farm/app/assets/tokens/tokens.css'
createApp({
  components: { SpoolIllustration },
  data: () => ({ red: { color_hex: 'E04030' }, blue: { color_hex: '3080E0' } }),
  template: `<main style="background:var(--color-surface);color:var(--color-text);padding:2rem"><div v-for="entry in [{name:'Cor', f:red, n:0.7},{name:'Azul', f:blue, n:0.7},{name:'Zero', f:red, n:0},{name:'Desconhecido', f:red, n:null}]" :key="entry.name" style="display:inline-grid;padding:1rem"><SpoolIllustration :filament="entry.f" :fraction="entry.n"/><span>{{entry.name}}</span></div></main>`,
}).mount('#app')
