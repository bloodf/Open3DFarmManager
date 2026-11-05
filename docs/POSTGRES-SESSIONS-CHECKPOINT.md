# Persistência de sessões PostgreSQL

A migração `0004_account_sessions` e `PostgresSessionRepository` implementam o contrato de persistência de sessões independentes. O adaptador permanece desconectado das rotas. Usa `Bun.SQL`; a aplicação Nuxt gera um servidor Node, portanto esta implementação não comprova compatibilidade com o runtime de produção.

Os IDs são referências internas, nunca tokens de autenticação. Não há emissão de cookies, senha, login, recuperação de conta ou autorização por fazenda nesta etapa. A tabela `session_accounts` contém somente o estado de revogação e bloqueio de contas.

## Garantias implementadas

- Autorização, leitura da versão da conta e atualização de atividade ocorrem na mesma transação. A resposta positiva só retorna depois do COMMIT.
- As operações bloqueiam primeiro a conta e depois a sessão. A vinculação entre conta e sessão é imutável. A revogação de todas as sessões incrementa a versão da conta sem ultrapassar o maior inteiro seguro do JavaScript.
- Expiração absoluta e inatividade rejeitam a sessão exatamente no limite. Uma expiração observada grava revogação terminal na mesma transação, impedindo reativação por regressão posterior do relógio. O relógio também não pode retroceder em relação à atividade persistida da sessão.
- Erros do banco retornam `storage-unavailable` na autorização. Revogações lançam erro quando não conseguem confirmar a gravação. As consultas usam limite de dois segundos e esperas por bloqueios de um segundo. O chamador administra o pool e seus limites de conexão.
- A role `farm_session_runtime` não pode criar sessões, alterar identidade, reativar sessões revogadas, apagar dados, executar DDL ou conceder privilégios. Ela pode atualizar atividade, revogar uma sessão e incrementar versões. Credenciais dessa role exigem proteção; ela não representa isolamento entre fazendas.
- Revogação remota não alcança imediatamente um Connector desconectado. Esta persistência não define nem resolve a política de comandos offline.

## Verificação isolada

O script `scripts/test-postgres-sessions.ts` exige PostgreSQL descartável e vazio, acessível apenas por loopback, com banco e usuário sintéticos `fixture`. Nunca aponte para um banco usado pela aplicação.

```sh
SESSIONS_SYNTHETIC_TEST_DISPOSABLE=yes SESSIONS_SYNTHETIC_TEST_PORT=15433 bun scripts/test-postgres-sessions.ts
# Reinicie somente a instância descartável criada para este teste.
SESSIONS_SYNTHETIC_TEST_DISPOSABLE=yes SESSIONS_SYNTHETIC_TEST_PORT=15433 bun scripts/test-postgres-sessions.ts --after-restart
```

A primeira execução verifica limites, bloqueio de conta, isolamento de contas, ambas as ordens de corrida entre autorização e revogação, rollback, falha no COMMIT, timeout de bloqueio e privilégios restritos. A segunda verifica atividade e revogações após reinício, repete verificações de privilégios e executa down/up/down. Remove o schema e as roles da fixture. A primeira execução conserva dados para a verificação após reinício; o coordenador é responsável pela instância descartável e por preservar evidências de falhas.

O coordenador executou as duas fases com sucesso no PostgreSQL 17.11 ARM64 isolado, usando o mesmo digest registrado no checkpoint de capacidades. A atividade avançou de 100 para 150 antes do reinício e permaneceu persistida depois dele; uma autorização em 249 comprova que o novo limite de inatividade foi mantido. A expiração observada também permaneceu terminal após reinício e regressão do relógio.

O banco usa dados sintéticos, publicação somente em loopback, volume e rede dedicados, UID/GID 70, capacidades removidas e limites de CPU, memória e processos. Sua bridge não bloqueia tráfego de saída. O teste não usa impressoras nem banco de produção. `tsc --noEmit` passou; login HTTP e aceitação completa da Fase 0 continuam pendentes.
