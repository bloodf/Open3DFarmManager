<script setup lang="ts">
import { reactive, watch } from 'vue'
import EmptyState from '../ui/EmptyState.vue'
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
</script>

<template>
  <section aria-labelledby="members-heading">
    <h2 id="members-heading">Membros</h2>
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
          <button
            type="button"
            :disabled="
              pending || !draftFor(member) || draftFor(member) === member.role
            "
            @click="requestRole(member)"
          >
            Alterar papel
          </button>
          <button
            type="button"
            :disabled="pending"
            :aria-label="`Remover ${memberDisplayName(member)}`"
            @click="emit('remove', member)"
          >
            Remover
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.member-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 1.25rem;
}
li {
  display: grid;
  gap: 0.75rem;
  padding-block: 0.75rem;
  border-block-end: 1px solid color-mix(in srgb, currentColor 20%, transparent);
}
.identity {
  display: grid;
  gap: 0.25rem;
}
.name {
  font-weight: 700;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}
label,
select,
button {
  font: inherit;
}
select,
button {
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
}
button {
  cursor: pointer;
}
button:disabled,
select:disabled {
  cursor: not-allowed;
}
button:focus-visible,
select:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 3px;
}
</style>
