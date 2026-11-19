<script setup lang="ts">
import {
  ANYCUBIC_SLICER_NEXT_PATH_HINTS,
  processSelectedKobraCertFiles,
  type KobraCertCachedFile,
} from '../../utils/kobra-client-cert-ui.ts'
import {
  KOBRA_X_BRIDGE_CHOICE_HELP,
  KOBRA_X_BRIDGE_CHOICE_LABEL,
  KOBRA_X_NATIVE_CHOICE_HELP,
  KOBRA_X_NATIVE_CHOICE_LABEL,
} from '../../utils/kobra-x-setup-mode.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'

const {
  kobraIp,
  kobraSetupMode,
  kobraCertSource,
  kobraCertPassphrase,
  kobraCertInstallPath,
  kobraCertFileName,
  kobraCertSummary,
  kobraCertError,
  kobraCertInline,
  kobraCertFiles,
  kobraError,
} = usePrinterSetup()

async function runFileValidation(files: readonly KobraCertCachedFile[]) {
  kobraError.value = ''
  if (!files.length) {
    kobraCertInline.value = null
    kobraCertSummary.value = null
    kobraCertError.value = ''
    kobraCertFileName.value = ''
    return
  }
  const res = await processSelectedKobraCertFiles({
    files,
    passphrase: kobraCertPassphrase.value || undefined,
  })
  kobraCertSummary.value = res.summary
  if (res.ok) {
    kobraCertInline.value = res.payload
    kobraCertFileName.value = res.fileLabel
    kobraCertError.value = ''
  } else {
    kobraCertInline.value = null
    kobraCertFileName.value = files.map((f) => f.name).join(', ')
    kobraCertError.value = res.error
  }
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement | null
  const list = input?.files ? Array.from(input.files) : []
  if (!list.length) {
    kobraCertFiles.value = []
    await runFileValidation([])
    return
  }
  const cached: KobraCertCachedFile[] = await Promise.all(
    list.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  )
  kobraCertFiles.value = cached
  await runFileValidation(cached)
}

function onSourceChanged() {
  kobraError.value = ''
  kobraCertError.value = ''
  if (kobraCertSource.value === 'install-path') {
    kobraCertPassphrase.value = ''
    kobraCertInline.value = null
    kobraCertFiles.value = []
    kobraCertFileName.value = ''
    kobraCertSummary.value = null
  }
}

async function onPassphraseInput() {
  if (kobraCertFiles.value.length) {
    await runFileValidation(kobraCertFiles.value)
  }
}
</script>

<template>
  <fieldset aria-describedby="kobra-mode-native-help kobra-mode-bridge-help">
    <legend>Conexão da Kobra X</legend>
    <div class="kobra-mode-option">
      <input
        id="kobra-mode-native"
        v-model="kobraSetupMode"
        type="radio"
        name="kobra-setup-mode"
        value="native"
        aria-describedby="kobra-mode-native-help"
      />
      <div>
        <label for="kobra-mode-native">{{ KOBRA_X_NATIVE_CHOICE_LABEL }}</label>
        <p id="kobra-mode-native-help">{{ KOBRA_X_NATIVE_CHOICE_HELP }}</p>
      </div>
    </div>
    <div class="kobra-mode-option">
      <input
        id="kobra-mode-bridge"
        v-model="kobraSetupMode"
        type="radio"
        name="kobra-setup-mode"
        value="kobralink-bridge"
        aria-describedby="kobra-mode-bridge-help"
      />
      <div>
        <label for="kobra-mode-bridge">{{ KOBRA_X_BRIDGE_CHOICE_LABEL }}</label>
        <p id="kobra-mode-bridge-help">{{ KOBRA_X_BRIDGE_CHOICE_HELP }}</p>
      </div>
    </div>
  </fieldset>

  <label for="kobra-ip">Endereço IPv4 da Kobra X na LAN</label>
  <input
    id="kobra-ip"
    v-model="kobraIp"
    required
    maxlength="15"
    autocomplete="off"
    spellcheck="false"
    aria-describedby="kobra-x-intro kobra-ip-help"
  />
  <p id="kobra-ip-help">Informe um IPv4 privado na LAN (ex.: 192.168.1.50).</p>

  <label for="kobra-cert-source">
    Certificado de cliente MQTT do Anycubic Slicer Next
  </label>
  <select
    id="kobra-cert-source"
    v-model="kobraCertSource"
    aria-describedby="kobra-cert-help"
    @change="onSourceChanged"
  >
    <option value="file">Importar arquivo (PEM ou PKCS#12 .p12/.pfx)</option>
    <option value="install-path">
      Caminho da instalação do Anycubic Slicer Next no host do Connector
    </option>
  </select>
  <p id="kobra-cert-help">
    O broker MQTT da Kobra X exige o certificado de cliente distribuído pelo
    Anycubic Slicer Next (CN=AnycubicSlicer). Ele é validado localmente e
    enviado diretamente para guarda privada no Connector (0600); a chave privada
    nunca é salva no servidor nem exibida novamente.
  </p>

  <template v-if="kobraCertSource === 'file'">
    <label for="kobra-cert-file">
      Arquivo(s) do certificado e chave (.pem/.crt + .key ou .p12/.pfx)
    </label>
    <input
      id="kobra-cert-file"
      type="file"
      multiple
      accept=".pem,.crt,.cer,.key,.p12,.pfx"
      aria-describedby="kobra-cert-file-help"
      @change="onFileSelected"
    />
    <p id="kobra-cert-file-help">
      Selecione um PKCS#12 (.p12/.pfx), um PEM combinado (certificado + chave),
      ou selecione simultaneamente o certificado e a chave privada (.crt/.pem +
      .key).
    </p>
    <label for="kobra-cert-passphrase">
      Senha do certificado (opcional para PEM sem senha / PKCS#12)
    </label>
    <input
      id="kobra-cert-passphrase"
      v-model="kobraCertPassphrase"
      type="password"
      autocomplete="off"
      @input="onPassphraseInput"
    />
    <p v-if="kobraCertFileName">Arquivo selecionado: {{ kobraCertFileName }}</p>
  </template>

  <template v-else>
    <label for="kobra-cert-install-path">
      Caminho da instalação do Anycubic Slicer Next
    </label>
    <input
      id="kobra-cert-install-path"
      v-model="kobraCertInstallPath"
      maxlength="1024"
      autocomplete="off"
      spellcheck="false"
      aria-describedby="kobra-cert-locations"
    />
    <div id="kobra-cert-locations">
      <p>Locais típicos onde o Anycubic Slicer Next costuma ficar instalado:</p>
      <ul>
        <li v-for="hint in ANYCUBIC_SLICER_NEXT_PATH_HINTS" :key="hint">
          {{ hint }}
        </li>
      </ul>
    </div>
  </template>

  <p
    v-if="kobraCertError && kobraCertError !== kobraError"
    role="alert"
    class="kobra-alert"
  >
    {{ kobraCertError }}
  </p>

  <dl v-if="kobraCertSummary && !kobraCertError">
    <dt>Formato validado</dt>
    <dd>{{ kobraCertSummary.format.toUpperCase() }}</dd>
    <dt>Subject</dt>
    <dd class="exact-key">{{ kobraCertSummary.subject }}</dd>
    <dt>Validade (expiry)</dt>
    <dd class="exact-key">{{ kobraCertSummary.notAfterIso }}</dd>
  </dl>
</template>

<style scoped src="./printer-setup.css"></style>
