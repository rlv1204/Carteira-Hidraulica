try {
  var tema = localStorage.getItem('ch.dash.theme');
  if (tema) document.documentElement.dataset.theme = tema;
} catch (e) {}
