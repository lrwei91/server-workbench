import { $, $$, announce, DialogController, el, getJson, postJson } from '/shared/ui.js';

const prefix = location.pathname.startsWith('/cdr') ? '/cdr' : '';
const dialog = new DialogController($('#intakeDialog'));
const form = $('#intakeForm');
const container = $('#intakeFiles');
const button = $('#btnPrepareIntake');
const status = $('#intakeStatus');
const resultPanel = $('#intakeResult');
const fileLimit = 10;
let busy = false;

const checked = () => $$('input:checked', container);

function updateControls() {
  const selected = checked().length;
  $('#intakeFields').disabled = busy;
  button.disabled = busy || selected < 1 || selected > fileLimit;
  $('#intakeCount').textContent = `已选 ${selected} / ${fileLimit} 个文件`;
}

async function refreshFiles() {
  if (busy) return;
  const selected = new Set(checked().map(input => input.value));
  busy = true;
  updateControls();
  announce(status, '正在读取候选文件…');
  try {
    const lists = await getJson(`${prefix}/api/intake/files`);
    container.replaceChildren();
    for (const [scope, title] of [['source', '源目录'], ['export', '导出目录']]) {
      const group = el('fieldset', { class: 'intake-file-group' }, el('legend', { text: title }));
      for (const { name, size_bytes } of lists[scope]) {
        const input = el('input', { type: 'checkbox', value: JSON.stringify({ scope, name }) });
        input.checked = selected.has(input.value);
        group.append(el('label', {}, input, el('span', { text: `${name} · ${size_bytes} 字节` })));
      }
      if (!lists[scope].length) group.append(el('p', { text: '没有候选文件' }));
      container.append(group);
    }
    announce(status, '');
  } catch (error) {
    announce(status, error.message, 'error');
  } finally {
    busy = false;
    updateControls();
  }
}

$('#btnOpenIntake').addEventListener('click', () => {
  dialog.open($('#intakePeriod'));
  void refreshFiles();
});
$('#btnCloseIntake').addEventListener('click', () => dialog.close());
$('#btnRefreshIntake').addEventListener('click', refreshFiles);
form.addEventListener('change', () => {
  resultPanel.hidden = true;
  announce(status, checked().length > fileLimit ? '单批最多选 10 个文件' : '');
  updateControls();
});
form.addEventListener('input', event => {
  if (event.target === $('#intakePeriod')) {
    resultPanel.hidden = true;
    announce(status, '');
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  const payload = {
    files: checked().map(input => JSON.parse(input.value)),
    period: $('#intakePeriod').value,
    period_field: $('#intakePeriodField').value,
  };
  busy = true;
  resultPanel.hidden = true;
  updateControls();
  announce(status, '正在校验并生成投递包…');
  try {
    const result = await postJson(`${prefix}/api/intake/prepare`, payload);
    $('#intakePath').textContent = result.output_path;
    $('#intakeManifest').replaceChildren(...result.files.map(file => el('li', {
      text: `${file.source_name} → ${file.name} · ${file.record_count} 条 · ${file.size_bytes} 字节`,
    })));
    resultPanel.hidden = false;
    announce(status, `本地准备完成：${result.file_count} 个文件、${result.record_count} 条 · 尚未投递`, 'success');
  } catch (error) {
    announce(status, error.message, 'error');
  } finally {
    busy = false;
    updateControls();
  }
});
