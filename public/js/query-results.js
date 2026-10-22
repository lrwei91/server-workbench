import { el, formatDate } from '/shared/ui.js';

export function displayValue(value, column = '') {
  if (value === null || value === undefined || value === '') return '—'; if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value); if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return formatDate(text, { withZone: true, milliseconds: true });
  if (/(?:date|time|时间|_at)$/i.test(String(column)) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) return `${text.replace('T', ' ')} +08:00`;
  return text;
}
export function rowField(row, name) { const wanted = String(name).toLowerCase(); const key = Object.keys(row || {}).find((candidate) => candidate.toLowerCase() === wanted); return key === undefined ? undefined : row[key]; }
export function renderTable(rows, { rowAction } = {}) {
  if (!rows?.length) return el('div', { class: 'query-section-empty', text: '无数据或关联缺失' });
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const head = el('tr'); columns.forEach((column) => head.append(el('th', { text: column }))); if (rowAction) head.append(el('th', { text: '操作' }));
  const body = el('tbody');
  rows.forEach(row => {
    const tr = el('tr');
    columns.forEach(column => {
      const text = displayValue(row[column], column);
      const cell = el('td', { title: text }, el('span', { text }));
      if (['prod_inst_id', 'product_instance_id'].includes(column.toLowerCase()) && /^\d{1,20}$/.test(String(row[column]))) {
        const actions = el('span', { class: 'instance-actions' });
        for (const [destination, label] of [['query', '查看档案'], ['redis', '在 Redis 中打开']]) actions.append(el('button', {
          class: 'text-action', type: 'button', text: label,
          on: { click: () => document.dispatchEvent(new CustomEvent('workbench:instance', { detail: { id: String(row[column]), destination } })) },
        }));
        cell.append(actions);
      }
      tr.append(cell);
    });
    if (rowAction) tr.append(el('td', { class: 'query-table-action' }, rowAction(row)));
    body.append(tr);
  });
  return el('div', { class: 'query-table-wrap' }, el('table', { class: 'query-table' }, el('thead', {}, head), body));
}
export function resultSection(title, rows, { open = false, actions = [], table = '', rowAction } = {}) {
  if (!rows?.length) {
    const fragment = document.createDocumentFragment(); const availableActions = actions.filter((action) => !action.disabled);
    if (availableActions.length) fragment.append(el('div', { class: 'query-row-actions' }, ...availableActions));
    return fragment;
  }
  const tableSuffix = table ? ` · ${table}` : '';
  const details = el('details', { class: 'query-section', ...(open ? { open: true } : {}) }, el('summary', { text: `${title} · ${rows?.length || 0} 条${tableSuffix}` }), renderTable(rows, { rowAction }));
  if (actions.length) details.append(el('div', { class: 'query-row-actions' }, ...actions));
  return details;
}

/** Keep only the selected result group visible, without recreating its table. */
export function watchQueryResults(root) {
  let layout, nav, content, active;
  const positions = new WeakMap();
  function group() {
    const added = [...root.children].filter(node => node.matches('.query-section'));
    if (!added.length) return;
    if (!layout?.isConnected) {
      nav = el('nav', { class: 'result-groups', 'aria-label': '查询结果分组' });
      content = el('div', { class: 'result-group-content' });
      layout = el('div', { class: 'result-browser' }, nav, content);
      root.append(layout); active = null;
    }
    const overview = root.querySelector(':scope > .query-summary');
    if (overview) [...root.children].filter(node => node.matches('.query-row-actions')).forEach(node => overview.append(node));
    const preferred = added.find(section => /^(产品实例 ·|订购用户汇总 ·|档位提醒配置 ·)/.test(section.querySelector('summary').textContent)) || added[0];
    for (const section of added) {
      const title = section.querySelector('summary').textContent;
      const button = el('button', { class: 'result-group-button', type: 'button', text: title, title });
      function select() {
        if (active) positions.set(active, content.scrollTop);
        active = section;
        [...content.children].forEach(node => node.classList.toggle('hidden', node !== section));
        [...nav.children].forEach(node => { node.classList.toggle('active', node === button); if (node === button) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current'); });
        content.scrollTop = positions.get(section) || 0;
      }
      button.addEventListener('click', select);
      const summary = section.querySelector('summary'); summary.tabIndex = -1; summary.addEventListener('click', event => event.preventDefault());
      section.open = true; section.classList.add('hidden');
      nav.append(button); content.append(section);
      if (!active && section === preferred) select();
    }
  }
  new MutationObserver(group).observe(root, { childList: true });
}
