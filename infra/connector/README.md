# Connector em contêiner

Execute os comandos a partir da raiz do repositório. O volume `connector-data`
contém a identidade e a fila; mantenha-o em backups privados. O volume
`connector-config` contém a configuração e a credencial. Não remova esses
volumes durante a atualização ou recriação do contêiner.

```sh
docker compose -f infra/connector/compose.yaml build
docker compose -f infra/connector/compose.yaml run --rm connector init-identity --data-dir /data
docker compose -f infra/connector/compose.yaml run --rm connector status --data-dir /data
```

Faça o pareamento com `pair` e coloque `runtime.json` e `credential.json` no
volume de configuração antes de executar `docker compose -f
infra/connector/compose.yaml up -d`. Os arquivos privados devem pertencer ao
UID 1000 e não permitir escrita de grupo ou outros usuários. Consulte
`packages/connector/README.md` para o pareamento e os requisitos de recuperação.

O exemplo usa a rede do host para os candidatos ICE do WebRTC. Use um host
Linux e configure os endereços ICE no Connector conforme a rede. O suporte à
rede do host no Docker Desktop depende da versão e da configuração; valide-o no
host de destino. Sem conectividade WebRTC não há fallback de comandos por HTTP.
