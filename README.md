# Painel da Carteira Hidráulica

Página estática (um único `index.html`) para acompanhar e editar o quadro **Carteira Hidráulica** do Trello: quadro por etapa, resumo, grade e lembretes.

- **Sem dados neste repositório.** A página fala direto com a API oficial do Trello (`api.trello.com`) no navegador de quem abre, com chave e token guardados só naquele navegador (localStorage). Não há servidor nem scripts ou fontes externas.
- **Edição:** criar tarefa, registrar andamento, mover de etapa (arrastando o cartão ou pelo painel da tarefa), lembrete, aguardando, prioridade, plataforma, em andamento, referências, checklist, concluir e arquivar. Antes de gravar a descrição, a página relê o cartão para não apagar mudanças feitas em outro lugar.
- A descrição do cartão segue o formato da carteira: `**Aguardando:**`, `**Refs:**`, `**Prioridade:**`, `**Criada em:**` e o histórico abaixo de `**Histórico**`, com a linha mais recente no topo (`dd/mm - texto`).
- Atualiza sozinha a cada 5 minutos com a aba aberta, ao voltar para a aba, ou pelo botão **Atualizar** (atalho `R`). Atalhos: `/` busca, `N` nova tarefa.

## Aba Prompts

A pasta `prompts/` é a página de prompts, aberta pela aba **Prompts** da Carteira. Ela não guarda dados: o prompt e o resultado ficam no quadro privado **Prompts** do Trello.

- Usa a mesma conexão da Carteira. Em navegador novo, conecte a Carteira uma vez e volte para a aba.
- O prompt fica na descrição do cartão, com número no título (`P012 - Título`).
- O resultado fica nos comentários. Resultado longo vai em partes, com `[parte 1/3]` na primeira linha, e a página junta tudo.
- Atualiza a cada 30 segundos com a aba aberta. Atalhos: `N` novo prompt, `R` atualizar, `/` busca, `Ctrl+Enter` salvar.

## Primeiro acesso em cada navegador

1. Em <https://trello.com/power-ups/admin>, crie um app e gere a **Chave de API** em *Autenticação do Trello*.
2. Cole a chave na página, clique em **Gerar token**, permita o acesso (leitura e escrita) e cole o token.
3. Para revogar: Trello → Configurações → Aplicativos, ou **Desconectar este navegador** na página.
