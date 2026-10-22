import { $, $$, el } from '/shared/ui.js';

/** Native popovers escape the list's clipping area; existing action handlers are retained. */
export function compactResourceActions(actions, name) {
  const buttons = [...actions.children];
  if (buttons.length < 3) return;
  const menu = el('div', { class: 'row-action-menu', popover: 'auto', 'aria-label': `${name} 的操作` });
  const trigger = el('button', { class: 'fact', type: 'button', text: '更多', 'aria-label': `更多操作：${name}`, 'aria-expanded': 'false' });
  buttons.slice(1).forEach(button => menu.append(button));
  actions.append(trigger, menu);
  trigger.addEventListener('click', () => {
    if (menu.matches(':popover-open')) { menu.hidePopover(); return; }
    menu.showPopover();
    const rect = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector('button')?.focus();
  });
  menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
  menu.addEventListener('click', event => { if (event.target.closest('button')) menu.hidePopover(); }, true);
}

/** Path editing never replaces the list, so its scroll position survives overlays. */
export function initResourcePaths() {
  for (const [pane, inputId, gotoId, crumbsId] of [
    ['filesPane', 'pathInput', 'btnGoto', 'crumbs'],
    ['hdfsPane', 'hdfsPathInput', 'btnHdfsGoto', 'hdfsCrumbs'],
    ['hbasePane', 'hbasePathInput', 'btnHbaseGoto', 'hbaseCrumbs'],
  ]) {
    const root = $(`#${pane}`), toolbar = $('.path-toolbar', root), crumbs = $(`#${crumbsId}`), input = $(`#${inputId}`);
    const edit = el('button', { class: 'wb-button ghost path-edit', type: 'button', text: '编辑路径', 'aria-label': '编辑当前路径' });
    const bar = el('div', { class: 'location-bar' }, crumbs, edit);
    toolbar.before(bar);
    toolbar.classList.add('hidden');
    function close() { toolbar.classList.add('hidden'); bar.classList.remove('hidden'); edit.focus(); }
    let saved = input.value;
    edit.addEventListener('click', () => { saved = input.value; bar.classList.add('hidden'); toolbar.classList.remove('hidden'); input.focus(); input.select(); });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); input.value = saved; close(); } });
    $(`#${gotoId}`).addEventListener('click', close);
    // Keep the refresh and parent actions available without entering path-edit mode.
    const up = toolbar.querySelector('button:first-child');
    const refresh = toolbar.querySelector('button:last-child');
    for (const original of [up, refresh]) {
      const proxy = el('button', { class: 'wb-button ghost', type: 'button', text: original.textContent, 'aria-label': original.getAttribute('aria-label') || original.textContent });
      proxy.addEventListener('click', () => original.click());
      bar.insertBefore(proxy, crumbs);
    }
  }
}

export function renderBreadcrumbs(container, current, rootLabel, navigate) {
  const tilde = current === '~' || current.startsWith('~/');
  container.replaceChildren(el('button', { type: 'button', text: tilde ? '~' : '/', on: { click: () => navigate(tilde ? rootLabel : '/') } }));
  const parts = current.replace(tilde ? /^~\/?/ : /^\//, '').split('/').filter(Boolean);
  let built = tilde ? '~' : '';
  for (const [index, part] of parts.entries()) {
    built += `/${part}`; const target = built;
    if (index > 0 || tilde) container.append(el('span', { class: 'sep', text: '/' }));
    container.append(el('button', { type: 'button', text: part, on: { click: () => navigate(target) } }));
  }
}
