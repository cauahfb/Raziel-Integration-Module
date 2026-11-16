# Raziel Integration — MVP 0.3.1

Módulo experimental para Foundry VTT 14.359 + sistema D&D 5e 5.3.3.

## Novidades da versão 0.3.1

- Mapeia bônus de CA, PV máximos, iniciativa, CD de magia, testes de resistência, testes de atributo, perícias e Percepção passiva.
- Mapeia bônus genérico de jogadas de ataque e dano para ataques corpo a corpo, à distância, com arma e com magia.
- Mapeia deslocamento por tipo (caminhar, escavar, escalar, voo e natação). Os valores e unidades recebidos do Raziel são preservados, sem conversão automática. Velocidades concedidas usam `UPGRADE`, preservando uma velocidade já superior.
- Mantém efeitos não reconhecidos no texto da Feature e os contabiliza como não suportados no relatório.

## Escopo

- Importa snapshot JSON completo exportado pelo Raziel.
- Permite selecionar manualmente um Actor do tipo `character`.
- Cria uma Feature (`Item` do tipo `feat`) para cada talento comum adquirido.
- Atualiza a Feature existente usando o ID do talento no Raziel.
- Remove Features gerenciadas pelo módulo quando o talento não aparece mais no snapshot completo.
- Não importa Supremas e não altera Items que não tenham a flag de gerenciamento do Raziel.

## Instalação / atualização

1. Feche o Foundry.
2. Substitua a pasta antiga `Data/modules/raziel-integration` pela pasta `raziel-integration` desta versão.
3. Reinicie o Foundry e confirme a versão 0.3.1 em Gerenciar Módulos.
4. Como GM, abra Configurações > Raziel Integration > Abrir painel.
5. Importe o JSON atualizado e sincronize primeiro em uma cópia do Actor.

## Segurança e limitações

- Apenas GM pode abrir e executar a sincronização.
- O JSON deve conter `completeSnapshot: true`.
- Features manuais e Features de outros módulos são preservadas.
- O módulo usa Active Effects nativos do D&D 5e; nem todo efeito do Raziel possui correspondência direta. Efeitos condicionais, resistências, vantagens/desvantagens específicas, substituições complexas de atributo e habilidades especiais ainda precisam de adaptadores próprios.
- Ativação, ação bônus, reação, alcance, duração e frequência continuam registrados na Feature/flags, mas não controlam automaticamente o uso em combate.
- A sincronização direta é feita por solicitação remota confirmada pelo GM; a importação JSON manual permanece como contingência temporária.
- Testar primeiro em uma cópia do Actor/mundo.

## Teste recomendado com Novrik

Com o JSON enviado, a expectativa é: `vida` aplica +12 PV máximos; `jogada` aplica +123 às quatro categorias de jogada de ataque; `12334567` concede voo de 3 m, preservando a unidade recebida e elevando a velocidade de voo quando aplicável; `CABEEÇA` aplica +2 CA. O valor de ataque `123` foi preservado literalmente para testar o mapeamento; depois substitua-o por um valor real de jogo.

Faça também um teste de sincronização repetida e confirme que não surgem Features duplicadas.


## Atividades nativas (0.3.0)

O módulo lê `talents[].activities` do JSON do Raziel e cria atividades no objeto
`system.activities` da Feature. Tipos tratados: `attack`, `save`, `damage`,
`heal` e `utility`. Os IDs são derivados dos identificadores estáveis do Raziel.
Na sincronização, atividades próprias do usuário são preservadas; somente as
atividades marcadas como gerenciadas pelo Raziel são substituídas.

As medidas recebidas são mantidas sem conversão. Os valores e unidades de
alcance e área são enviados conforme o JSON. A forma como o D&D 5e interpreta
unidades depende do modelo de dados e das configurações de distância do sistema.

A descrição da Feature usa seções simples para descrição, benefícios passivos e
instruções de atividades, sem parágrafos HTML aninhados.

Compatibilidade de escrita das Activities precisa ser confirmada no Foundry 14
build 359 com D&D 5e 5.3.3. O módulo não possui runtime Foundry local para
validar a criação e execução dentro do cliente.


## Integração remota (0.3.0 — fundação)

O módulo agora oferece pareamento com o Supabase e mantém uma conexão de saída
enquanto o GM estiver no mundo. Não é necessário abrir portas no roteador nem
expor o Foundry à internet.

1. Configure no painel do módulo a URL do projeto Supabase e a chave anon/public.
2. No Raziel, o administrador gera um código de pareamento (validade de 5 minutos).
3. Informe o código no painel do módulo e pareie a instalação.
4. O módulo consulta a Edge Function `raziel-foundry-bridge` a cada 10 segundos.
5. A conexão é considerada ativa quando a última comunicação ocorreu nos últimos
   45 segundos.

O UUID de destino configurado para esta integração é
`Actor.khbUpl3bQVdtB3Ms`. O pareamento armazena a instalação e a credencial
secreta do módulo em configuração por usuário GM. A chave `service_role` nunca deve
ser inserida no Foundry ou no navegador.

A sincronização remota com confirmação do GM é preparada pelo fluxo de
solicitações no Supabase. A importação JSON manual permanece temporariamente
disponível durante a validação da comunicação direta.

## Deploy Supabase

- Execute `supabase/migrations/202611160002_foundry_remote_integration.sql`.
- Publique a Edge Function `raziel-foundry-bridge`.
- Configure os segredos padrão do projeto Supabase (`SUPABASE_URL`,
  `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY`) no ambiente da função.
- O módulo usa somente URL e chave anon/public no painel; o token pareado é
  entregue uma única vez e fica armazenado nas configurações do mundo.

A confirmação remota e o retorno de status devem ser testados em um mundo de
teste antes de usar o personagem principal.


## Ajuste de interface (0.3.1)

- O painel agora permite rolagem vertical pelo conteúdo da janela, usando a roda do mouse ou a barra de rolagem. Nenhuma rotina de importação, pareamento ou sincronização foi alterada.


## Importação manual flexível (0.3.2)

Na importação manual de JSON, o GM pode selecionar qualquer Actor do tipo
`character` no mundo atual. O nome e o UUID registrados no JSON são ignorados
para determinar o destino; os dados são aplicados ao Actor selecionado. A
validação do formato do snapshot, da origem Raziel, da versão do schema, dos
IDs dos talentos e da marcação de snapshot completo permanece ativa.

A sincronização remota não foi flexibilizada: continua resolvendo o Actor pelo
UUID associado à instalação e validando o destino antes de aplicar alterações.


## Versão 0.3.3

- As Features gerenciadas pelo Raziel recebem o requisito nativo `Desbloqueado pelo Raziel`.
- O requisito também é atualizado em Features já existentes durante a reconciliação.
- Nenhuma alteração no pareamento, sincronização remota, importação manual, atividades ou efeitos.
