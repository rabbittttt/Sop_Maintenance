const operationLogEntities = [
  ['', '全部操作'], ['plan', 'SOP计划'], ['demand', '要货计划'],
  ['shipment', '实际发货'], ['catalog', '车型与版本'], ['committee', '计委决策'], ['reconcile', '资料对账']
];
let operationLogCursors = [''];
let operationLogRequest = 0;
let operationLogLoading = false;
let operationLogMarkup = '';

function pollOperationLog() {
  if (page === 'operation-log' && !document.hidden && !operationLogLoading &&
      operationLogCursors.length === 1 && $('#operation-log-results')) {
    return operationLogPage({background:true});
  }
}

function operationLogTable(items) {
  if (!items.length) return '<div class="empty-state">暂无操作记录</div>';
  const rows = items.map(item => `<tr>
    <td>${esc(dateText(item.recorded_at))}</td>
    <td>${esc(item.owner || '—')}</td>
    <td>${esc(item.action)}</td>
    <td>${esc(item.subject || '—')}${item.month ? `<small>${esc(item.month)}</small>` : ''}</td>
    <td>${esc(item.detail || '—')}${item.reason ? `<small>${esc(item.reason)}</small>` : ''}</td>
  </tr>`).join('');
  return `<div class="table-scroll" tabindex="0" aria-label="操作记录"><table class="detail-table" aria-label="操作记录">
    <thead><tr>${['操作时间','维护账号','操作','对象 / 月份','变更内容'].map(col => `<th scope="col">${col}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

async function operationLogPage({background=false}={}) {
  if (page !== 'operation-log') return;
  let filter = $('#operation-log-filter');
  if (!filter) {
    operationLogCursors = [''];
    $('#app').innerHTML = pageHeading() + `<div class="filterbar"><label class="field inline-field">业务类型
      <select id="operation-log-filter">${operationLogEntities.map(([id, label]) => opt(id, label, '')).join('')}</select>
      </label></div><section class="card" id="operation-log-results" aria-label="操作记录"></section>`;
    filter = $('#operation-log-filter');
    filter.onchange = () => {
      operationLogCursors = [''];
      return operationLogPage();
    };
  }
  const request = ++operationLogRequest;
  operationLogLoading = true;
  const content = $('#operation-log-results');
  const isCurrent = () => request === operationLogRequest && page === 'operation-log' && content.isConnected;
  const params = new URLSearchParams();
  if (filter.value) params.set('entity', filter.value);
  const cursor = operationLogCursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  if (!background) {
    operationLogMarkup = '';
    content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<div class="empty-state" role="status">正在读取操作记录…</div>';
  }
  try {
    const {items, next_cursor: next} = await api('/api/operations' + (params.size ? '?' + params : ''));
    if (!isCurrent()) return;
    const pageNumber = operationLogCursors.length;
    const pager = pageNumber > 1 || next ? `<div class="table-footer">
      <span>第 ${pageNumber} 页</span><div class="toolbar">
        <button type="button" class="button small" id="operation-log-prev"${pageNumber === 1 ? ' disabled' : ''}>上一页</button>
        <button type="button" class="button small" id="operation-log-next"${next ? '' : ' disabled'}>下一页</button>
      </div></div>` : '';
    const markup = operationLogTable(items) + pager;
    if (background && markup === operationLogMarkup && (next || '') === content.dataset.nextCursor) return;
    operationLogMarkup = markup;
    content.dataset.nextCursor = next || '';
    content.innerHTML = markup;
    if (pager) {
      $('#operation-log-prev').onclick = () => { operationLogCursors.pop(); return operationLogPage(); };
      $('#operation-log-next').onclick = () => { operationLogCursors.push(next); return operationLogPage(); };
    }
  } catch (error) {
    if (!isCurrent() || background) return;
    content.innerHTML = `<div class="empty-state"><span role="alert">${esc(error.message || '操作记录读取失败')}</span>
      <button type="button" class="button small" id="operation-log-retry">重试</button></div>`;
    $('#operation-log-retry').onclick = operationLogPage;
  } finally {
    if (request === operationLogRequest) operationLogLoading = false;
    if (!background && isCurrent()) content.setAttribute('aria-busy', 'false');
  }
}
