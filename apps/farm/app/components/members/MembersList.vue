<script setup lang="ts">
import { reactive, watch } from 'vue'
import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import MembersSection from './MembersSection.vue'
import {
  assignableRoles,
  memberDisplayName,
  roleLabel,
  roleSelectValue,
  type AssignableRole,
  type FarmMember,
} from '../../utils/members-page.ts'

const props = defineProps<{
  members: readonly FarmMember[]
  pending: boolean
}>()

const emit = defineEmits<{
  changeRole: [member: FarmMember, role: AssignableRole]
  remove: [member: FarmMember]
}>()

const drafts = reactive<Record<string, AssignableRole | ''>>({})

watch(
  () => props.members,
  (members) => {
    for (const member of members) {
      drafts[member.accountId] = roleSelectValue(member)
    }
  },
  { immediate: true, deep: true },
)

function draftFor(member: FarmMember): AssignableRole | '' {
  return drafts[member.accountId] ?? roleSelectValue(member)
}

function setDraft(member: FarmMember, value: string) {
  drafts[member.accountId] = (
    assignableRoles.some((role) => role.value === value) ? value : ''
  ) as AssignableRole | ''
}

function requestRole(member: FarmMember) {
  const role = draftFor(member)
  if (!role || role === member.role) return
  emit('changeRole', member, role)
}

function selectId(member: FarmMember) {
  return `member-role-${member.accountId}`
}

function summary(count: number) {
  return count === 1 ? '1 membro' : `${count} membros`
}
</script>

<template>
  <MembersSection
    heading-id="members-heading"
    title="Membros"
    :summary="members.length ? summary(members.length) : undefined"
    :bordered="members.length > 0"
  >
    <EmptyState
      :level="3"
      v-if="members.length === 0"
      title="Nenhum membro nesta farm"
      description="Convide uma pessoa para que ela passe a participar desta farm."
    >
      <NuxtLink to="/convites">Convidar uma pessoa</NuxtLink>
    </EmptyState>
    <ul v-else class="member-list">
      <li v-for="member in members" :key="member.accountId">
        <div class="identity">
          <span class="name">{{ memberDisplayName(member) }}</span>
          <span class="role">Papel atual: {{ roleLabel[member.role] }}</span>
        </div>
        <div class="actions">
          <div class="role-field">
            <label :for="selectId(member)">Novo papel</label>
            <select
              :id="selectId(member)"
              :value="draftFor(member)"
              :disabled="pending"
              :aria-label="`Novo papel para ${memberDisplayName(member)}`"
              @change="
                setDraft(member, ($event.target as HTMLSelectElement).value)
              "
            >
              <option v-if="member.role === 'owner'" value="" disabled>
                {{ roleLabel.owner }}
              </option>
              <option
                v-for="item in assignableRoles"
                :key="item.value"
                :value="item.value"
              >
                {{ item.label }}
              </option>
            </select>
          </div>
          <Button
            :disabled="
              pending || !draftFor(member) || draftFor(member) === member.role
            "
            @click="requestRole(member)"
          >
            Alterar papel
          </Button>
          <Button
            class="danger"
            :disabled="pending"
            :aria-label="`Remover ${memberDisplayName(member)}`"
            @click="emit('remove', member)"
          >
            Remover
          </Button>
        </div>
      </li>
    </ul>
  </MembersSection>
</template>

<style scoped>
.member-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
}
li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: flex-end;
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
  flex: 1 1 12rem;
}
.name {
  font-weight: var(--font-weight-semibold);
  overflow-wrap: anywhere;
}
.role {
  font-size: var(--ops-text-small);
  color: var(--ops-muted);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: flex-end;
  min-width: 0;
}
.role-field {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
select:focus-visible {
  outline: var(--focus-ring-width) solid var(--color-focus-ring);
  outline-offset: var(--focus-ring-offset);
}
@media (max-width: 30rem) {
  .actions,
  .role-field {
    width: 100%;
  }
  .actions > :deep(.ui-button) {
    flex: 1 1 auto;
  }
}
</style>
