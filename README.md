# GlicSense — coleta de dados

Aplicação web local para registrar participantes identificados por código, sessões de teste e medições de referência junto aos sinais ópticos, de temperatura e de força do GlicSense.

## Requisitos

- Node.js 20 ou superior
- npm

## Executar

```powershell
npm install
npm start
```

Abra [http://127.0.0.1:3000](http://127.0.0.1:3000). Para testes, execute `npm test`.

Por padrão, o banco SQLite é criado em `data/glicsense.sqlite`. Defina `DATA_DIRECTORY` para alterar onde o arquivo local é armazenado e `PORT` para mudar a porta. O servidor escuta somente em `127.0.0.1` por padrão; configure `HOST` conscientemente caso precise disponibilizá-lo na rede.

## Banco de dados SQL

O esquema SQL está em [`database/schema.sql`](./database/schema.sql). Ele cria as tabelas `patients`, `sessions` e `measurements`, suas chaves estrangeiras, validações e índices. O backend aplica esse mesmo arquivo automaticamente ao iniciar; não é necessário executá-lo manualmente para o uso local.

Este script é para **SQLite** e não pode ser importado diretamente em MySQL ou PostgreSQL. Para publicar o site, hospede a aplicação Node.js em um serviço que aceite processos Node e configure armazenamento persistente para o arquivo do banco:

1. Instale as dependências com `npm install` e use `npm start` como comando de inicialização.
2. Configure `HOST=0.0.0.0` para permitir que a plataforma encaminhe tráfego para o servidor.
3. Configure `DATA_DIRECTORY` para o caminho de um disco/volume persistente fornecido pela plataforma. Não use apenas o disco temporário do serviço: o banco pode ser perdido em uma nova publicação ou reinicialização.
4. Use a URL e a porta fornecidas pela plataforma. O servidor usa a variável `PORT` automaticamente.

SQLite é a opção mais simples para uma instância única com disco persistente. Se a hospedagem não oferecer volume persistente ou se várias instâncias da aplicação precisarem gravar dados, será necessário migrar o backend e o esquema para um banco gerenciado como PostgreSQL; este arquivo SQLite não serve para essa configuração.

## API

- `GET /api/summary` — contagens de participantes, sessões e medições.
- `GET /api/sessions` — sessões recentes, até 100, com contagem de leituras.
- `POST /api/sessions` — cria ou atualiza o perfil com `participantCode`, `ageRange`, `sex` e `notes`, e inicia uma nova sessão.
- `GET /api/sessions/:id` — consulta uma sessão.
- `PATCH /api/sessions/:id` — encerra a sessão.
- `GET /api/sessions/:id/measurements` — lista leituras da sessão.
- `POST /api/sessions/:id/measurements` — registra `referenceMgDl`; os campos `optical`, `temperatureC` e `force` são opcionais para integração com o ESP32.

Cada medição mantém os valores recebidos em `raw_data` e os valores numéricos padronizados (quatro casas decimais) em `processed_data`, vinculados à sessão e ao participante por chaves estrangeiras. A interface solicita somente o valor da glicose; os sinais de sensores podem ser enviados pelo ESP32 usando os campos opcionais `optical`, `temperatureC` e `force`. O pré-processamento atual limita-se à padronização numérica; não aplica filtros ou transformações de sinal que possam alterar a metodologia experimental. O servidor não possui autenticação nem criptografia, portanto o banco local deve permanecer em ambiente controlado e não deve ser exposto diretamente à internet. Use códigos de pesquisa e siga o protocolo de consentimento e privacidade da instituição.

## Integração com o ESP32

A tela oferece registro manual dos três sinais. Um firmware ou serviço local pode enviar os mesmos campos numéricos à rota `POST /api/sessions/:id/measurements` para registrar leituras automaticamente. A sessão precisa estar aberta.