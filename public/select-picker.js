// 使用原控件保存值，任务窗格统一渲染菜单。
function setupPicker(source, input) {
  const trigger = input ?? document.createElement('button');
  const label = trigger.labels?.[0] ?? source.labels?.[0];
  const id = input?.id ?? source.id;
  const menu = document.createElement('div');
  menu.id = `${id}Menu`;
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  let valueLabel;
  if (!input) {
    trigger.id = `${id}Trigger`;
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    valueLabel = document.createElement('span');
    valueLabel.id = `${id}Value`;
    trigger.append(valueLabel);
    source.after(trigger);
    source.hidden = true;
    if (label) label.htmlFor = trigger.id;
  } else {
    input.removeAttribute('list');
    input.setAttribute('aria-autocomplete', 'list');
  }
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-controls', menu.id);
  trigger.setAttribute('aria-expanded', 'false');
  if (label) {
    label.id ||= `${id}Label`;
    menu.setAttribute('aria-labelledby', label.id);
    trigger.setAttribute('aria-labelledby', valueLabel ? `${label.id} ${valueLabel.id}` : label.id);
  }
  const dialog = trigger.closest('dialog');
  (dialog ?? document.body).append(menu);

  let options = [];
  let activeIndex = -1;
  let session;

  function refresh() {
    if (valueLabel) {
      valueLabel.textContent = source.selectedOptions[0]?.text ?? '';
      trigger.disabled = source.disabled || !source.options.length;
    }
  }

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    session?.abort();
    session = undefined;
  }

  function activate(index) {
    options[activeIndex]?.item.removeAttribute('data-active');
    activeIndex = Math.max(0, Math.min(index, options.length - 1));
    const { item } = options[activeIndex];
    item.setAttribute('data-active', '');
    trigger.setAttribute('aria-activedescendant', item.id);
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }

  function choose(index) {
    const { option } = options[index];
    close();
    trigger.focus();
    const field = input ?? source;
    if (field.value === option.value) return;
    field.value = option.value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function positionMenu() {
    const bounds = trigger.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    const dialogBounds = dialog?.getBoundingClientRect();
    if (!bounds.width || bounds.bottom <= (dialogBounds?.top ?? 0) || bounds.top >= (dialogBounds?.bottom ?? viewportHeight)) {
      close();
      return;
    }
    menu.style.left = `${bounds.left}px`;
    menu.style.width = `${bounds.width}px`;
    const below = viewportHeight - bounds.bottom - 12;
    const above = bounds.top - 12;
    const fullHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    const opensBelow = below >= fullHeight || below >= above;
    menu.style.maxHeight = `${Math.max(0, opensBelow ? below : above)}px`;
    menu.style.top = `${opensBelow ? bounds.bottom + 4 : bounds.top - menu.offsetHeight - 4}px`;
  }

  function open(query = '') {
    options = [];
    for (const option of source.options) {
      if (option.disabled || option.hidden || !option.value || (query && !option.value.toLowerCase().includes(query))) continue;
      const item = document.createElement('div');
      item.id = `${menu.id}-${options.length}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === (input ?? source).value));
      item.textContent = option.label || option.value;
      const index = options.length;
      item.addEventListener('click', () => choose(index));
      options.push({ option, item });
    }
    if (!options.length) { close(); return; }
    menu.replaceChildren(...options.map(({ item }) => item));
    menu.hidden = false;
    positionMenu();
    if (menu.hidden) return;
    menu.scrollTop = 0;
    trigger.setAttribute('aria-expanded', 'true');
    activeIndex = -1;
    trigger.removeAttribute('aria-activedescendant');
    if (!input) activate(options.findIndex(({ option }) => option === source.selectedOptions[0]));
    if (session) return;

    session = new AbortController();
    const { signal } = session;
    document.addEventListener('pointerdown', event => {
      if (!trigger.contains(event.target) && !menu.contains(event.target)) close();
    }, { signal });
    document.addEventListener('focusin', event => {
      if (event.target !== trigger && !menu.contains(event.target)) close();
    }, { signal });
    document.addEventListener('scroll', event => {
      if (event.target !== menu) positionMenu();
    }, { capture: true, signal });
    window.addEventListener('resize', close, { signal });
    window.addEventListener('blur', close, { signal });
  }

  menu.addEventListener('mousedown', event => {
    if (event.target.closest('[role="option"]')) event.preventDefault();
  });
  trigger.addEventListener('click', () => {
    if (menu.hidden) open();
    else if (!input) close();
  });
  trigger.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (menu.hidden && !arrow) return;
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (arrow) {
      event.preventDefault();
      if (menu.hidden) open();
      else if (activeIndex === -1) activate(event.key === 'ArrowUp' ? options.length - 1 : 0);
      else activate(activeIndex + (event.key === 'ArrowUp' ? -1 : 1));
      if (input && !menu.hidden && activeIndex === -1) activate(event.key === 'ArrowUp' ? options.length - 1 : 0);
    } else if (event.key === 'Enter' || (!input && event.key === ' ')) {
      if (activeIndex === -1) { close(); return; }
      event.preventDefault();
      choose(activeIndex);
    } else if (!input && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      activate(event.key === 'Home' ? 0 : options.length - 1);
    }
  });
  dialog?.addEventListener('close', close);
  if (input) input.addEventListener('input', event => {
    if (!event.isComposing) open(input.value.trim().toLowerCase());
  });
  else source.addEventListener('change', refresh);
  refresh();
  return { refresh, focus: () => trigger.focus(), close };
}

export function enhancePickers() {
  const pickers = new Map();
  for (const select of document.querySelectorAll('select')) pickers.set(select, setupPicker(select));
  for (const input of document.querySelectorAll('input[list]')) setupPicker(input.list, input);
  return pickers;
}
