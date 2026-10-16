// The redesign's questions page (new-faq.html): the live FAQ from /api/faq (faq.js), over the shipped questions until it answers,
// and the menu shared with new.html (home-menu.js).
import { initFaq } from './faq.js';
import { initMenu } from './home-menu.js';

initMenu(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
initFaq(document.getElementById('faqList'));
