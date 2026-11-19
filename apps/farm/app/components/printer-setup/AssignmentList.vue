<script setup lang="ts">
import {
  KOBRA_X_DEVICE_CAPABILITIES,
  isKobraXAssignment,
} from '../../utils/kobralink-onboarding.ts'
import AssignmentGrouping from '../printers/AssignmentGrouping.vue'
import MachineProfile from '../machine-profile/MachineProfile.vue'
import PrinterIdentity from '../printer-identity/PrinterIdentity.vue'
import {
  liveConnectionLabel,
  livePrinterStateText,
} from '../../utils/printer-setup-live.ts'
import { usePrinterSetup } from '../../utils/printer-setup-state.ts'
import { usePrinterSetupActions } from '../../utils/printer-setup-actions.ts'

const {
  farmId,
  printers,
  nextPrinter,
  canManage,
  pending,
  kobraDisplayLabels,
  liveObservations,
} = usePrinterSetup()
const { selectRevocation, run, loadAssignments } = usePrinterSetupActions()
const setup = usePrinterSetup()
const connectionLabel = (id: string) => liveConnectionLabel(setup, id)
const stateText = (id: string) => livePrinterStateText(setup, id)
</script>

<template>
  <section v-if="farmId" aria-labelledby="assignment-heading">
    <h2 id="assignment-heading">Atribuições</h2>
    <p v-if="!pending && !printers.length">Nenhuma atribuição nesta página.</p>
    <ul>
      <li v-for="printer in printers" :key="printer.assignmentId">
        <PrinterIdentity
          :identity="liveObservations[printer.assignmentId]?.state.identity"
          :firmware="liveObservations[printer.assignmentId]?.state.firmware"
        />
        <dl>
          <dt>Chave exata</dt>
          <dd class="exact-key">{{ printer.printerKey }}</dd>
          <template v-if="kobraDisplayLabels[printer.printerKey]">
            <dt>Apelido local nesta sessão</dt>
            <dd class="exact-key">
              {{ kobraDisplayLabels[printer.printerKey] }}
            </dd>
          </template>
          <dt>Connector</dt>
          <dd>{{ printer.agentId }}</dd>
          <dt>Estado da atribuição</dt>
          <dd>
            {{
              printer.status === 'revoked'
                ? 'Revogada permanentemente'
                : 'Ativa'
            }}
          </dd>
          <dt>Autorização atual do Connector</dt>
          <dd>
            {{
              printer.connectorStatus === 'approved'
                ? 'Aprovado'
                : printer.connectorStatus === 'revoked'
                  ? 'Revogado, uso indisponível'
                  : 'Pendente, uso indisponível'
            }}
          </dd>
          <template
            v-if="
              isKobraXAssignment(printer) ||
              printer.printerKey.startsWith('moonraker-')
            "
          >
            <dt>Modelo e qualificação</dt>
            <dd>
              {{
                printer.printerKey.startsWith('moonraker-')
                  ? 'Klipper / Moonraker'
                  : 'Anycubic Kobra X'
              }}
              (qualificação provisória; firmware não qualificado — somente
              leitura)
            </dd>
            <dt>Conexão direta WebRTC</dt>
            <dd>{{ connectionLabel(printer.assignmentId) }}</dd>
            <dt>Último estado informado via WebRTC</dt>
            <dd>
              {{ stateText(printer.assignmentId) }}
              <template
                v-if="
                  liveObservations[printer.assignmentId]?.state.state ===
                    'printing' &&
                  liveObservations[printer.assignmentId]?.state.progress !==
                    undefined
                "
              >
                ({{
                  Math.round(
                    liveObservations[printer.assignmentId]!.state.progress! *
                      100,
                  )
                }}%)
              </template>
              <span
                v-if="
                  liveObservations[printer.assignmentId]?.state.progress ===
                  undefined
                "
                >Progresso indisponível.</span
              >
            </dd>
          </template>
        </dl>
        <div
          v-if="isKobraXAssignment(printer)"
          class="capability-box"
          role="region"
          :aria-labelledby="'kobra-cap-' + printer.assignmentId"
        >
          <h3 :id="'kobra-cap-' + printer.assignmentId">
            Capacidades admitidas por dispositivo ({{ printer.printerKey }})
          </h3>
          <dl>
            <div v-for="cap in KOBRA_X_DEVICE_CAPABILITIES" :key="cap.id">
              <dt>{{ cap.label }}</dt>
              <dd>{{ cap.statusText }} — {{ cap.reason }}</dd>
            </div>
          </dl>
        </div>
        <AssignmentGrouping
          :key="farmId + ':' + printer.assignmentId"
          :printer="printer"
        />
        <MachineProfile
          v-if="printer.status === 'active'"
          :key="'profile:' + farmId + ':' + printer.assignmentId"
          :farm-id="farmId"
          :assignment-id="printer.assignmentId"
          :label="printer.displayName || printer.printerKey"
          :can-manage="canManage"
        />
        <button
          v-if="canManage && printer.status === 'active'"
          type="button"
          :disabled="pending"
          @click="selectRevocation(printer)"
        >
          Revogar atribuição de {{ printer.printerKey }}
        </button>
      </li>
    </ul>
    <button
      v-if="nextPrinter"
      type="button"
      :disabled="pending"
      @click="
        run((signal, current) => loadAssignments(signal, current, nextPrinter))
      "
    >
      Próximas atribuições
    </button>
    <p v-if="!canManage">
      Somente proprietários e administradores podem cadastrar, adicionar uma
      Klipper / Moonraker, Anycubic Kobra X ou revogar atribuições.
    </p>
  </section>
</template>

<style scoped src="./printer-setup.css"></style>
