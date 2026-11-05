# Aprovação de Connector por fazenda

A migração `0006_farm_memberships` cria fazendas e associações entre fazenda e conta independente. Os papéis são `owner`, `admin`, `operator` e `viewer`. Uma associação revogada permanece como registro terminal; esta etapa não implementa readmissão. Mudanças de papel são possíveis somente enquanto a associação estiver ativa.

`PostgresFarmAuthorization.approve` recebe uma referência interna de sessão, fazenda, Connector, fingerprint esperado, horário e política de inatividade. A conta vem exclusivamente da sessão persistida. A referência de sessão não é token de acesso. Um futuro endpoint precisará extraí-la do cookie autenticado e validar Origin; nenhum endpoint foi criado nesta etapa.

A operação bloqueia conta, sessão, associação e registro do Connector, nessa ordem. Reavalia sessão e conta com `evaluateSession` dentro da mesma transação que aprova o Connector. Somente `owner` e `admin` ativos podem aprovar. A consulta vincula exatamente fazenda, Connector e fingerprint `SHA256:`. Uma repetição só aceita o mesmo registro aprovado; revogação do Connector é terminal. Sucesso só retorna após COMMIT, com atualização de atividade da sessão.

Se uma revogação ou redução de papel confirmar antes da aprovação, a operação nega acesso. Se a aprovação adquirir os bloqueios primeiro, confirma antes da alteração concorrente. A revogação de uma associação ou sessão não desfaz retroativamente uma aprovação já confirmada. Ela impede novas aprovações e suas repetições. Revogação do próprio Connector permanece uma operação distinta.

Consultas têm limite de dois segundos e bloqueios de um segundo. Falha de armazenamento retorna `storage-unavailable`. Sessão inválida, expirada ou revogada, conta bloqueada, associação insuficiente e divergência de identificação retornam `denied`. Expiração observada grava a revogação da sessão, evitando recuperação por retrocesso posterior do relógio.

A role sem login `farm_enrollment_approver` possui leitura das tabelas necessárias, atualização de atividade/revogação da sessão e do status do Connector. Os privilégios de atualização em identificadores existem apenas para permitir bloqueios PostgreSQL; os gatilhos rejeitam alterações desses identificadores. A role não altera papéis nem cria associações. Suas credenciais devem permanecer no backend confiável: o privilégio SQL de alterar status não substitui a autorização da aplicação e não pode ser concedido a clientes.

## Verificação

`testPostgresFarmAuthorization(admin, port)` em `tests/helpers/postgres-farm-authorization-integration.ts` exige banco `fixture` descartável, acessível por loopback, com migrações 0001, 0004 e 0006 já aplicadas. O coordenador controla o banco. O helper cria e remove somente sua role sintética `farm_approval_fixture`; conserva linhas de teste para inspeção até o descarte da fixture.

O helper verifica papéis permitidos e negados, isolamento por fazenda, fingerprint, sessão ausente/expirada, conta bloqueada, idempotência, ambas as ordens de concorrência para revogação de associação, redução de papel, revogação de sessão e de todas as sessões da conta. Usa bloqueios reais e uma pausa por advisory lock no gatilho de atualização. Também verifica falha no COMMIT, rollback do status e da atividade, timeout, recuperação e privilégios mínimos.

O coordenador executou o helper com PostgreSQL 17.11 isolado e Node 24. Todos os grupos retornados passaram, incluindo isolamento entre duas fazendas existentes, as duas ordens das corridas, falha de COMMIT, recuperação após timeout e restrições da role. As migrações 0005 e 0006 foram aplicadas, revertidas na ordem inversa, reaplicadas e revertidas novamente em um cluster PostgreSQL descartável isolado. A integração HTTP e o ciclo completo de inscrição continuam pendentes. Não há emissão de credenciais, ciclo de códigos de dispositivo, API pública, WebRTC, autorização de comandos ou acesso a impressoras nesta etapa. Portanto, este checkpoint não conclui o pareamento nem a Fase 0.
