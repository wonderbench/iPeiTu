import { VIEW_ACTIVATED } from './view-refresh.js';

const shell = document.querySelector('.manage-shell');
const header = document.querySelector('.manage-header');
const sections = [...document.querySelectorAll('.manage-content iframe')].map(frame => ({
  frame,
  link: document.querySelector(`.manage-nav a[href="#${frame.id}"]`),
}));

let activeSection;

function updateDialogState() {
  const open = Boolean(activeSection.frame.contentDocument?.querySelector('dialog[open]'));
  shell.toggleAttribute('data-dialog-open', open);
  header.inert = open;
}

const dialogObserver = new MutationObserver(updateDialogState);

function observeDialogs() {
  dialogObserver.disconnect();
  for (const dialog of activeSection.frame.contentDocument?.querySelectorAll('dialog') ?? []) {
    dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }
  updateDialogState();
}

function refreshActiveSection() {
  activeSection?.frame.contentWindow?.dispatchEvent(new Event(VIEW_ACTIVATED));
}

function showSection() {
  activeSection = sections.find(({ link }) => link.hash === location.hash) ?? sections[0];
  for (const section of sections) {
    const active = section === activeSection;
    section.frame.hidden = !active;
    if (active) {
      section.link.setAttribute('aria-current', 'page');
      if (!section.frame.hasAttribute('src')) section.frame.src = section.frame.dataset.src;
    } else {
      section.link.removeAttribute('aria-current');
    }
  }
  observeDialogs();
  refreshActiveSection();
}

for (const section of sections) {
  section.frame.addEventListener('load', () => {
    if (section === activeSection) observeDialogs();
  });
}

window.addEventListener('hashchange', showSection);
window.addEventListener('focus', refreshActiveSection);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshActiveSection();
});
showSection();
