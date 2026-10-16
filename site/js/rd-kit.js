// rd-kit.html's two demo buttons: the bottom sheet and the toast (window.dugriRd, from redesign-shell.js).
(function () {
  var sheet = document.getElementById('kitSheet');
  document.getElementById('kitSheetBtn').addEventListener('click', function () {
    sheet.showModal();
  });
  document.getElementById('kitSheetX').addEventListener('click', function () {
    sheet.close();
  });
  sheet.addEventListener('click', function (e) {
    if (e.target === sheet) sheet.close();
  });
  document.getElementById('kitToastBtn').addEventListener('click', function () {
    window.dugriRd.toast('נשמר');
  });
})();
