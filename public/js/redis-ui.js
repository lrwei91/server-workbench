import { $, $$ } from '/shared/ui.js';

export function switchRedisTab(tab) {
  $$('[data-redis-tab]').forEach(button => {
    const active = button.dataset.redisTab === tab;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  });
  $$('[data-redis-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.redisPanel !== tab));
  $('#redisPage').dataset.task = tab;
  $('.redis-target').classList.toggle('hidden', tab === 'indexes');
}
