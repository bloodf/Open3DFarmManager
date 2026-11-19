<script setup lang="ts">
import { computed } from 'vue'
import { KOBRA_X_BRIDGE_REQUIRED_MESSAGE } from '../../utils/kobra-x-setup-mode.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'
import AnycubicFields from './AnycubicFields.vue'
import BambuFields from './BambuFields.vue'
import CrealityFields from './CrealityFields.vue'
import KobraXFields from './KobraXFields.vue'
import MoonrakerFields from './MoonrakerFields.vue'

const {
  kobraBusy,
  kobraBootstrap,
  kobraStage,
  kobraLabel,
  kobraExpectedDeviceId,
  kobraSetupMode,
  onboardingFamily,
} = usePrinterSetup()
const { prepareSelected, closeKobraSession } = usePrinterSetupActions()

const bridgeRequired = computed(
  () =>
    onboardingFamily.value === 'anycubic-kobra-x' &&
    kobraSetupMode.value !== 'kobralink-bridge',
)

// A new setup must name its transport again after any family change.
function onFamilyChanged() {
  kobraSetupMode.value = 'unselected'
  closeKobraSession()
}
</script>

<template>
  <form
    v-if="kobraStage === 'idle' || kobraStage === 'preparing'"
    @submit.prevent="prepareSelected()"
  >
    <fieldset :disabled="kobraBusy || kobraBootstrap.kind !== 'ready'">
      <legend>2. Preparar impressora na rede local</legend>
      <label for="onboarding-family">Família da impressora</label>
      <select
        id="onboarding-family"
        v-model="onboardingFamily"
        @change="onFamilyChanged"
      >
        <option value="anycubic-lan">Anycubic (LAN)</option>
        <option value="anycubic-kobra-x">Anycubic Kobra X</option>
        <option value="klipper-moonraker">Klipper / Moonraker</option>
        <option value="bambu-lan">Bambu Lab (LAN)</option>
        <option value="creality-native">Creality (firmware original)</option>
      </select>
      <MoonrakerFields v-if="onboardingFamily === 'klipper-moonraker'" />
      <AnycubicFields v-else-if="onboardingFamily === 'anycubic-lan'" />
      <CrealityFields v-else-if="onboardingFamily === 'creality-native'" />
      <BambuFields v-else-if="onboardingFamily === 'bambu-lan'" />
      <KobraXFields v-else />
      <label for="kobra-label"
        >Apelido local para identificação (opcional)</label
      >
      <input
        id="kobra-label"
        v-model="kobraLabel"
        maxlength="64"
        autocomplete="off"
        aria-describedby="kobra-label-help"
      />
      <p id="kobra-label-help">
        Apelido opcional com até 64 caracteres visíveis.
      </p>
      <template v-if="onboardingFamily === 'anycubic-kobra-x'">
        <label for="kobra-device-id"
          >Identidade esperada do dispositivo — device_id (opcional)</label
        >
        <input
          id="kobra-device-id"
          v-model="kobraExpectedDeviceId"
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="kobra-device-id-help"
        />
        <p id="kobra-device-id-help">
          Se já conhecer a identidade esperada, informe-a para conferência.
        </p>
      </template>
      <div class="kobra-actions">
        <button
          type="submit"
          :disabled="
            kobraBusy || kobraBootstrap.kind !== 'ready' || bridgeRequired
          "
          :aria-describedby="bridgeRequired ? 'kobra-submit-help' : undefined"
        >
          {{
            kobraBusy && kobraStage === 'preparing'
              ? 'Preparando no Connector…'
              : onboardingFamily === 'anycubic-lan'
                ? 'Preparar Anycubic (LAN)'
                : onboardingFamily === 'klipper-moonraker'
                  ? 'Preparar Klipper / Moonraker'
                  : onboardingFamily === 'bambu-lan'
                    ? 'Preparar Bambu Lab (LAN)'
                    : onboardingFamily === 'creality-native'
                      ? 'Preparar Creality'
                      : 'Preparar Anycubic Kobra X'
          }}
        </button>
      </div>
      <p v-if="bridgeRequired" id="kobra-submit-help">
        {{ KOBRA_X_BRIDGE_REQUIRED_MESSAGE }}
      </p>
    </fieldset>
  </form>
</template>

<style scoped src="./printer-setup.css"></style>
