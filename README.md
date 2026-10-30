# Painel da Carteira Hidráulica

Página estática (um único `index.html`) que mostra o quadro **Carteira Hidráulica** do Trello em formato de painel: quadro por etapa, resumo, grade e lembretes.

- **Sem dados neste repositório.** A página lê o Trello direto no navegador de quem abre, pela API oficial (`api.trello.com`), com chave e token de **somente leitura** guardados apenas naquele navegador (localStorage).
- Nada é enviado para outro servidor. Sem scripts ou fontes externas.
- Atualiza sozinha a cada 5 minutos com a aba aberta, ao voltar para a aba, ou pelo botão **Atualizar** (atalho `R`).
- Para editar tarefas, use o Trello; o painel reflete as mudanças na próxima leitura.

## Primeiro acesso em cada navegador

1. Gere uma chave de API em <https://trello.com/power-ups/admin> (Novo → Chave de API).
2. Cole a chave na página e clique em **Gerar token**; permita o acesso de leitura e cole o token.
3. Para revogar: Trello → Configurações → Aplicativos, ou o botão **Desconectar este navegador** na página.
