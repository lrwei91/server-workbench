import { $, $$ } from '/shared/ui.js';

export const ROUTES = Object.freeze({
  resources: ['files', 'hdfs', 'hbase'],
  query: ['phone', 'productInstance', 'offer', 'eventType', 'threshold', 'relations'],
  redis: ['archive', 'sync', 'indexes', 'history'],
  logs: [], cdr: [],
});
const PANELS = { resources: 'workspace', query: 'query', redis: 'redis', logs: 'processLogs', cdr: 'cdr' };
export function parseRoute(hash) {
  const match = /^#\/([A-Za-z]+)(?:\/([A-Za-z]+))?$/.exec(hash || '');
  const page = match && Object.hasOwn(ROUTES, match[1]) ? match[1] : 'resources';
  const tabs = ROUTES[page];
  return { page, tab: tabs.includes(match?.[2]) ? match[2] : tabs[0] || '' };
}
export function routeHash({ page, tab }) { return `#/${page}${tab ? `/${tab}` : ''}`; }

export function initNavigation({ onChange }) {
  let current = null;
  const lastTabs = {};
  function apply(route) {
    const key = routeHash(route);
    if (current && routeHash(current) === key) return;
    current = route; lastTabs[route.page] = route.tab;
    const panel = PANELS[route.page];
    $$('[data-primary-page]').forEach(button => {
      const active = button.dataset.primaryPage === panel;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $$('[data-primary-panel]').forEach(node => node.classList.toggle('hidden', node.dataset.primaryPanel !== panel));
    document.title = `${$(`[data-primary-page="${panel}"]`)?.textContent.trim() || '工作台'} · Server Workbench`;
    onChange(route);
  }
  function navigate(page, tab = lastTabs[page] || ROUTES[page]?.[0] || '') {
    const route = parseRoute(routeHash({ page, tab }));
    if (location.hash !== routeHash(route)) history.pushState(null, '', routeHash(route));
    apply(route);
  }
  $$('[data-primary-page]').forEach(button => button.addEventListener('click', () => navigate(Object.keys(PANELS).find(key => PANELS[key] === button.dataset.primaryPage))));
  for (const [selector, page, attr] of [['[data-tab]', 'resources', 'tab'], ['[data-query-tab]', 'query', 'queryTab'], ['[data-redis-tab]', 'redis', 'redisTab']]) {
    $$(selector).forEach(button => button.addEventListener('click', () => navigate(page, button.dataset[attr])));
  }
  function restore() {
    const route = parseRoute(location.hash);
    if (location.hash !== routeHash(route)) history.replaceState(null, '', routeHash(route));
    apply(route);
  }
  window.addEventListener('popstate', restore);
  window.addEventListener('hashchange', restore);
  restore();
  return { navigate, current: () => current };
}
