try {
  var tema = localStorage.getItem('ch.dash.theme');
  if (tema) document.documentElement.dataset.theme = tema;
} catch (e) {}
/* Bloco de notas aberto dentro do painel da Carteira */
if (/[?&]painel(=|&|$)/.test(location.search) && window.parent !== window) document.documentElement.classList.add('painel');
/* acompanha a troca de tema feita em outra aba ou na Carteira que contém o painel */
window.addEventListener('storage', function (e) {
  if (e.key !== 'ch.dash.theme') return;
  if (e.newValue) document.documentElement.dataset.theme = e.newValue;
  else delete document.documentElement.dataset.theme;
});
