<script setup lang="ts">
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
</script>

<template>
  <section aria-labelledby="invites-heading">
    <h2 id="invites-heading">Convites pendentes</h2>
    <p v-if="invites.length === 0" role="status">
      Nenhum convite pendente nesta farm.
    </p>
    <ul v-else class="invite-list">
      <li v-for="invite in invites" :key="invite.id">
        <div class="identity">
          <span class="role">Papel: {{ roleLabel[invite.role] }}</span>
          <span class="expiry"
            >Expira em {{ formatInviteExpiry(invite.expiresAt) }}</span
          >
        </div>
        <button
          type="button"
          :disabled="pending"
          :aria-label="`Revogar convite de ${roleLabel[invite.role]}`"
          @click="emit('revoke', invite)"
        >
          Revogar convite
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.invite-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 1rem;
}
li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: center;
  justify-content: space-between;
  padding-block: 0.75rem;
  border-block-end: 1px solid color-mix(in srgb, currentColor 20%, transparent);
}
.identity {
  display: grid;
  gap: 0.25rem;
}
.role {
  font-weight: 700;
}
button {
  font: inherit;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
}
button:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
