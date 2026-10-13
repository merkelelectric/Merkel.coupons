// رسم QR لكل كوبون (بيفتح صفحة التسجيل والكود مكتوب)
(function () {
  function draw() {
    var ok = typeof window.QRCode === 'function';
    document.querySelectorAll('.qr').forEach(function (el) {
      if (!ok) { el.style.display = 'none'; return; }
      new window.QRCode(el, { text: el.getAttribute('data-url'), width: 160, height: 160, correctLevel: window.QRCode.CorrectLevel.M });
      el.removeAttribute('title');
    });
  }
  window.addEventListener('load', draw);
  var b = document.getElementById('doPrint');
  if (b) b.addEventListener('click', function () { window.print(); });
})();
