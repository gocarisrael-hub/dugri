// THE WHATSAPP HELP BUTTON RIDES IN THE PAY BAR WHILE THERE IS ONE.
//
// On the word-collection page the help button (css/wa-help.css) floats in the
// bottom-right corner, above the bars fixed to the foot of the page. The page's
// own controls scroll under that corner: on the owner's unpaid page the share
// box's buttons, the card-pay pill and the order button each passed under it
// by about 19px at 390px. The wizard solved the same thing by docking the help
// INTO its bar (.wa-help--docked), where nothing can ever be under it. This does
// the same on any page with a pay bar (#payBar): while the bar shows, the help
// moves into it, between the amount and the pay button; when the bar hides
// (contributors, a paid order, card payment off) it goes back to the exact spot
// it came from and floats as before.
//
// No page markup moves: the page keeps its one help button and its one bar, and
// this only re-parents the button while the bar is up. The bar shows and hides
// by its .hidden class (collect.html's renderOwnerState), so that is what is
// watched.
(function () {
  var help = document.querySelector('.wa-help:not(.wa-help--docked)');
  var bar = document.getElementById('payBar');
  if (!help || !bar || typeof MutationObserver !== 'function') return;

  var home = document.createComment('wa-help home');
  help.parentNode.insertBefore(home, help);

  function shown() {
    return !bar.classList.contains('hidden') && getComputedStyle(bar).display !== 'none';
  }
  function sync() {
    var docked = help.parentNode === bar;
    if (shown() && !docked) {
      // After the amount, before the pay button: the button keeps the far end.
      bar.insertBefore(help, document.getElementById('payBarBtn') || null);
      help.classList.add('wa-help--docked');
    } else if (!shown() && docked) {
      help.classList.remove('wa-help--docked');
      home.parentNode.insertBefore(help, home);
    }
  }
  sync();
  new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ['class'] });
})();
