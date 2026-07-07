/* Shared site header behaviour (index.html, products.html, product.html).
   The hamburger opens a slide-down menu panel; it closes on link click,
   on an outside click and on Esc. Progressive enhancement: the header
   markup is fully usable without JS (links work; the menu is just hidden).
   Loaded with `defer`, so the DOM is ready when this runs. */
(function () {
  var navToggle = document.querySelector('[data-testid="nav-toggle"]');
  var navMenu =
    document.querySelector('[data-testid="nav-menu"]') || document.getElementById('navMenu');
  if (!navToggle || !navMenu) return;

  function closeMenu() {
    navMenu.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  }

  navToggle.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = navMenu.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  navMenu.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', closeMenu);
  });

  document.addEventListener('click', function (e) {
    if (
      navMenu.classList.contains('open') &&
      !navMenu.contains(e.target) &&
      !navToggle.contains(e.target)
    ) {
      closeMenu();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && navMenu.classList.contains('open')) {
      closeMenu();
      navToggle.focus();
    }
  });
})();
