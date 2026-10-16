// The redesign's menu (new.html, new-faq.html): a sheet from the reading start whose ✕ grows out of the ≡. A link to a section of this
// page scrolls there and moves focus to its heading; a link to another page just goes.
const $ = (id) => document.getElementById(id);

/** @param {boolean} reduce prefers-reduced-motion: jump to a section instead of scrolling smoothly */
export function initMenu(reduce) {
  const menu = $('menu'),
    menuBtn = $('menuBtn');
  const closeMenu = () => {
    if (menu.open) menu.close();
  };
  menuBtn.addEventListener('click', () => {
    const r = menuBtn.getBoundingClientRect(),
      w = Math.min(window.innerWidth * 0.86, 380);
    menu.style.setProperty('--mx-t', r.top + 'px');
    menu.style.setProperty('--mx-r', Math.min(window.innerWidth - r.right, w - 44 - 16) + 'px');
    menu.classList.remove('xs');
    menu.showModal();
    menuBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add('xs')));
  });
  let menuTo = null; // a link that closed the menu: focus goes to that section, not back to the ≡
  menu.addEventListener('close', () => {
    menuBtn.setAttribute('aria-expanded', 'false');
    if (!menuTo) menuBtn.focus({ preventScroll: true });
  });
  $('menuX').addEventListener('click', closeMenu);
  menu.addEventListener('click', (e) => {
    if (e.target === menu) closeMenu();
  });
  menu.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', (e) => {
      const h = a.getAttribute('href');
      if (!h.startsWith('#')) return;
      e.preventDefault();
      menuTo = h;
      closeMenu();
      requestAnimationFrame(() => {
        document
          .querySelector(h)
          .scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        const t = document.querySelector(h + ' h2') || document.querySelector(h);
        t.tabIndex = -1;
        t.focus({ preventScroll: true });
        menuTo = null;
      });
    })
  );
  trapTab(menu);
}

// focus stays inside a sheet and visits every link and button: Tab is handled here, because Safari's own Tab skips links by default
export function trapTab(dlg) {
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('a[href], button:not([disabled])')].filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (!f.length) return;
    e.preventDefault();
    const i = f.indexOf(document.activeElement);
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  });
}
