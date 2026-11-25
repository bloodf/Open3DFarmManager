<script setup lang="ts">
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import MembersSection from './MembersSection.vue'
import {
  formatInviteExpiry,
  roleLabel,
  type FarmInvite,
} from '../../utils/members-page.ts'

defineProps<{
  invites: readonly FarmInvite[]
  pending: boolean
}>()

const emit = defineEmits<{
  revoke: [invite: FarmInvite]
}>()

function summary(count: number) {
  return count === 1 ? '1 convite' : `${count} convites`
}
</script>

<template>
  <MembersSection
    heading-id="invites-heading"
    title="Convites pendentes"
    :summary="invites.length ? summary(invites.length) : undefined"
    :bordered="invites.length > 0"
  >
    <EmptyState
      :level="3"
      v-if="invites.length === 0"
      title="Nenhum convite pendente"
      description="Todos os convites foram usados, expiraram ou foram revogados. Gere um novo link para convidar mais pessoas."
    >
      <NuxtLink to="/convites">Gerar novo convite</NuxtLink>
    </EmptyState>
    <ul v-else class="invite-list">
      <li v-for="invite in invites" :key="invite.id">
        <div class="identity">
          <span class="role">Papel: {{ roleLabel[invite.role] }}</span>
          <span class="expiry"
            >Expira em {{ formatInviteExpiry(invite.expiresAt) }}</span
          >
        </div>
        <Button
          class="danger"
          :disabled="pending"
          :aria-label="`Revogar convite de ${roleLabel[invite.role]}`"
          @click="emit('revoke', invite)"
        >
          Revogar convite
        </Button>
      </li>
    </ul>
  </MembersSection>
</template>

<style scoped>
.invite-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
}
li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: center;
  justify-content: space-between;
  padding-block: var(--ops-space-3);
  border-block-end: 1px solid var(--ops-border);
}
li:first-child {
  padding-block-start: 0;
}
li:last-child {
  padding-block-end: 0;
  border-block-end: 0;
}
.identity {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.role {
  font-weight: var(--font-weight-semibold);
}
.expiry {
  font-variant-numeric: tabular-nums;
  font-size: var(--ops-text-small);
  color: var(--ops-muted);
}
@media (max-width: 30rem) {
  li .danger {
    width: 100%;
  }
}
</style>
