# Painel da Carteira Hidráulica

Página estática (um único `index.html`) para acompanhar e editar o quadro **Carteira Hidráulica** do Trello: quadro por etapa, resumo, grade e lembretes.

- **Sem dados neste repositório.** A página fala direto com a API oficial do Trello (`api.trello.com`) no navegador de quem abre, com chave e token guardados só naquele navegador (localStorage). Não há servidor nem scripts ou fontes externas.
- **Token:** a página envia chave e token sempre no cabeçalho `Authorization`, nunca no endereço. O token não expira. Para cancelar o acesso, revogue no Trello.
- **Edição:** criar tarefa, registrar andamento, mover de etapa (arrastando o cartão ou pelo painel da tarefa), lembrete, aguardando, prioridade, plataforma, em andamento, referências, checklist, concluir e arquivar. Antes de gravar a descrição, a página relê o cartão para não apagar mudanças feitas em outro lugar.
- A descrição do cartão segue o formato da carteira: `**Aguardando:**`, `**Refs:**`, `**Prioridade:**`, `**Criada em:**` e o histórico abaixo de `**Histórico**`, com a linha mais recente no topo (`dd/mm - texto`).
- Atualiza sozinha a cada 5 minutos com a aba aberta, ao voltar para a aba, ou pelo botão **Atualizar** (atalho `R`). Atalhos: `/` busca, `N` nova tarefa.

## Aba Prompts

A pasta `prompts/` é a página de prompts, aberta pela aba **Prompts** da Carteira. Ela não guarda dados: o prompt e o resultado ficam no quadro privado **Prompts** do Trello.

- Usa a mesma conexão da Carteira. Em navegador novo, conecte a Carteira uma vez e volte para a aba.
- O prompt fica na descrição do cartão, com número no título (`P012 - Título`).
- O resultado fica nos comentários. Resultado longo vai em partes, com `[parte 1/3]` na primeira linha, e a página junta tudo.
- **Rodar IOS** deixa o cartão no topo de **A rodar**. Depois, use o ícone **Rodar prompt** no iPhone, que abre um chat novo com `roda`. Esse comando pega o primeiro cartão de **A rodar**. Para escolher outro, mande `roda o P012`. `roda tudo` roda a fila inteira.
- **Rodar Claude** move o cartão para **Rodando**. Uma regra de automação do Trello aciona a tarefa agendada do Claude, que roda na nuvem e grava o resultado no cartão, sem celular. A rodada fica na aba Code do app do Claude, não no chat. O token dessa tarefa fica só na regra do Trello, nunca neste repositório.
- A sessão grava `[exec] inicio` ao começar e `[exec] erro: motivo` se não concluir, movendo o cartão para **Erro**. A página não mostra esses comentários como resultado. Sem início em 5 minutos, ou sem novidade em 30, ela avisa e oferece **Voltar para A rodar**.
- Pergunta sobre um resultado fica em comentário com `[pergunta]` na primeira linha. O cartão volta para o topo de **A rodar**, e as duas opções de rodar ficam disponíveis.
- **Registrar na carteira**, no resultado, grava uma linha `dd/mm - texto` no histórico da tarefa escolhida, sem usar o Claude e sem mexer em etapa, lembrete ou prioridade. A página relê a tarefa antes de gravar.
- **Modelo**, em Novo prompt, coloca no texto os campos para preencher de GM, PQS, nota SAP, PATEC ou pesquisa de componente. O texto já escrito é mantido.
- **Cancelar** apaga a pergunta pendente ou desfaz **Rodar de novo**, e o cartão volta para **Pronto** sem perder os resultados.
- Resultado incompleto fica com os botões de copiar desligados. Se nada novo chegar em 10 minutos, a página avisa que a sessão pode ter parado.
- Atualiza a cada 30 segundos com a aba visível, a cada 10 segundos enquanto houver cartão em **Rodando** e a cada 2 minutos com a aba escondida. A quantidade de resultados novos aparece no título da aba. Atalhos: `N` novo prompt, `R` atualizar, `/` busca, `Ctrl+Enter` salvar.

## Bloco de notas

A pasta `notas/` é o Bloco de notas, aberto pela aba **Bloco de notas**. Serve para levar um texto do laptop até o chat do Claude: a nota escrita aqui aparece no artefato **Carteira Hidráulica**, no app do Claude, com um botão **Copiar**.

- As notas ficam no quadro **Prompts** do Trello, nas listas **Notas** (para copiar) e **Notas copiadas**. A aba Prompts ignora essas listas.
- A nota fica na descrição do cartão, com número no título (`N023 - primeira linha`).
- No app do Claude, **Copiar** coloca `[N023]` na primeira linha do texto e move o cartão para **Notas copiadas**. Esse código faz o Claude gravar a resposta na mesma nota, como comentário.
- A resposta aparece aqui, com os botões de copiar para Word ou Outlook. Resposta longa chega em partes (`[parte 1/3]`), e a página junta tudo.
- **Voltar para a fila** devolve uma nota copiada para o app do Claude. **Arquivar** tira a nota da lista (dá para restaurar no Trello).
- Atualiza a cada 30 segundos com a aba visível e a cada 2 minutos com a aba escondida. Atalhos: `N` nova nota, `R` atualizar, `/` busca, `Ctrl+Enter` salvar.

## Primeiro acesso em cada navegador

1. Em <https://trello.com/power-ups/admin>, crie um app e gere a **Chave de API** em *Autenticação do Trello*.
2. Cole a chave na página, clique em **Gerar token**, permita o acesso (leitura e escrita) e cole o token.
3. Para revogar: Trello → Configurações → Aplicativos, ou **Desconectar este navegador** na página.
