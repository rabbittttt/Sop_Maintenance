function snapshotBackupLabel(backup) {
  return ({ready:'Excel已备份',error:'Excel待重试',pending:'Excel生成中'})[backup?.status]||'Excel待生成';
}
function committeeModelName(modelKey){
  if(modelKey.startsWith('[')){
    try{
      const [type,parent,brand,model]=JSON.parse(modelKey);
      if(type==='member')return `${brand} · ${model} · 单代际（${parent}）`;
    }catch{/* The stored model key is still safe to display as text. */}
  }
  return modelKey.replace('|',' · ');
}
function committeeScopeName(decision){
  if(decision.scope==='all')return '全部';
  if(decision.scope==='brands')return (decision.brands||[]).join('、');
  return (decision.model_keys||[]).map(committeeModelName).join('、');
}
function committeeHistoryMonths({start_month,end_month}){
  if(!start_month||!end_month)return '';
  return ` · 计划月份 ${start_month===end_month?start_month:`${start_month}—${end_month}`}`;
}
function committeeHistory(items){
  if(!state.committee)return '';
  const records=items.map(item=>`<button class="snapshot-item${item.id===currentCommitteeDecision?.decision.id?' active':''}" type="button" data-committee-decision="${esc(item.id)}"><div><strong>${esc(item.period)} · ${committeeLevels[item.level]}</strong><span class="badge neutral">${item.model_count} 个车型</span></div><p>${esc(committeeScopeName(item)+committeeHistoryMonths(item))}</p><small>${esc(dateText(item.recorded_at))} · ${esc(item.owner)}</small></button>`).join('');
  return `<section class="card page-section"><div class="panel-head"><h2>计委记录</h2></div>${records?`<div class="snapshot-list">${records}</div>`:'<div class="empty-state">暂无计委记录</div>'}</section>`;
}
function renderCommitteeDecision(detail){
  const {decision,amounts,products=[],plans=[]}=detail;
  const byId=new Map(products.map(product=>[product.id,product]));
  const versions=plans.filter(row=>{const product=byId.get(row.product_id);return product&&!product.read_only&&!isModelPlan(product);});
  const quantity=value=>value==null?'':fmt(value);
  const modelName=row=>row.model_key?committeeModelName(row.model_key):`${row.brand} · ${row.model}`;
  const table=`<div class="table-scroll" tabindex="0" aria-label="计委车型总量"><table class="detail-table"><thead><tr><th>品牌 / 车型</th><th>目标月</th><th>计委量</th></tr></thead><tbody>${amounts.map(row=>`<tr><td>${esc(modelName(row))}</td><td>${esc(row.month)}</td><td>${quantity(row.sop)}</td></tr>`).join('')}</tbody></table></div>`;
  const details=versions.length?`<details class="committee-version-detail"><summary>版本明细</summary><div class="table-scroll" tabindex="0" aria-label="计委版本明细"><table class="detail-table"><thead><tr><th>品牌 / 车型</th><th>版本</th><th>目标月</th><th>计委量</th></tr></thead><tbody>${versions.map(row=>{
    const product=byId.get(row.product_id);
    return `<tr><td>${esc(committeeModelName(modelGroupKey(product)))}</td><td>${esc(product.version)}</td><td>${esc(row.month)}</td><td>${quantity(row.sop)}</td></tr>`;
  }).join('')}</tbody></table></div></details>`:'';
  $('#snapshot-detail').innerHTML=`<section class="card page-section committee-decision-detail"><div class="panel-head"><div><h2>${esc(decision.period)} · ${committeeLevels[decision.level]}</h2><p>${esc(committeeScopeName(decision)+committeeHistoryMonths(decision))} · ${esc(dateText(decision.recorded_at))} · ${esc(decision.owner)}</p></div></div>${table}${details}</section>`;
}
async function historyPage() {
  const [archive,backups,committees]=await Promise.all([
    api('/api/snapshots'),api('/api/backups/status'),state.committee?api('/api/committee-decisions'):{items:[]},
  ]);
  snapshotList=archive.items;
  const recent=[...snapshotList].sort((a,b)=>String(b.cutoff_at).localeCompare(String(a.cutoff_at)));
  const recentLeft=String(recent[1]?.id||''),recentRight=String(recent[0]?.id||'');
  if(currentSnapshot) currentSnapshot=await api(`/api/snapshots/${encodeURIComponent(currentSnapshot.snapshot.id)}`);
  $('#app').innerHTML=pageHeading('history')+
    `<div class="sync-strip ${backups.failed?'warn':''}"><div><strong>Excel备份 · 已生成 ${backups.ready}/${backups.total} 份</strong>${backups.failed?'<p>备份生成失败，等待重试</p>':backups.pending?'<p>备份生成中</p>':''}<small>${esc(backups.directory)}</small>${backups.last_error?`<p>${esc(backups.last_error)}</p>`:''}</div><div class="toolbar">${button('刷新备份状态','refresh-backups','small')}</div></div>
    <div class="two-col page-section"><section class="card"><div class="panel-head"><div><h2>快照档案</h2><p>${snapshotList.length} 份快照</p></div>${button('保存会议快照','create-snapshot','primary small')}</div>${snapshotList.length?`<div class="snapshot-list">${snapshotList.map(s=>`<button class="snapshot-item ${s.id===currentSnapshot?.snapshot?.id?'active':''}" data-snapshot="${esc(s.id)}"><div><strong>${esc(s.label||s.business_date)}</strong><span class="badge ${s.kind==='manual'?'good':'neutral'}">${s.kind==='sunday'?'周日考核':s.kind==='daily'?'每日快照':'会议快照'}</span></div><p>截点 ${dateText(s.cutoff_at)}</p><small>实际保存 ${dateText(s.created_at)} · ${s.plan_count??0} 条计划 · ${snapshotBackupLabel(s.excel_backup)}</small></button>`).join('')}</div>`:'<div class="empty-state">暂无快照</div>'}</section>
    <section class="card"><div class="panel-head"><div><h2>两次快照比较</h2></div></div><div class="card-body"><div class="form-grid"><label class="field">比较基准<select id="snapshot-left"><option value="">选择较早快照</option>${snapshotList.map(s=>opt(String(s.id),`${s.label||s.business_date} · ${dateText(s.cutoff_at)}`,recentLeft )).join('')}</select></label><label class="field">当前快照<select id="snapshot-right"><option value="">选择较新快照</option>${snapshotList.map(s=>opt(String(s.id),`${s.label||s.business_date} · ${dateText(s.cutoff_at)}`,recentRight )).join('')}</select></label></div><div class="dialog-actions">${button('查看变化','compare-snapshots','primary',snapshotList.length<2?'disabled':'')}</div><div id="comparison-result" class="empty-state compact">暂无比较结果</div></div></section></div>${committeeHistory(committees.items)}<section id="snapshot-detail"></section>`;
  if(currentSnapshot)renderSnapshot(currentSnapshot);
  else if(currentCommitteeDecision)renderCommitteeDecision(currentCommitteeDecision);
}
function renderSnapshot(d) {
  const s=d.snapshot; const prods=snapshotProducts(d),list=snapshotRows(d);
  const lookup=new Map(prods.map(p=>[p.id,p]));
  $('#snapshot-detail').innerHTML=`<div class="card page-section"><div class="panel-head"><div><h2>${esc(s.label||s.business_date)} · 快照明细</h2><p>截点 ${dateText(s.cutoff_at)} · 实际生成 ${dateText(s.created_at)} · 历史只读</p></div>${button('下载Excel备份','export-snapshot')}</div><div class="table-scroll"><table class="detail-table"><thead><tr><th>品牌 / 车型</th><th>版本</th><th>目标月</th><th>预测销量</th><th>SOP计划量</th><th>维护人</th><th>调整说明</th></tr></thead><tbody>${list.length?list.map(v=>{const p=lookup.get(v.product_id)||{};return `<tr><td>${esc(p.brand)} / ${esc(p.model)}</td><td>${esc(p.version||v.product_id)}</td><td>${v.month}</td><td>${v.forecast==null?'待维护':fmt(v.forecast)}</td><td>${v.sop==null?'待维护':fmt(v.sop)}</td><td>${esc(v.owner)}</td><td>${esc(v.notes)}</td></tr>`}).join(''):'<tr><td colspan="7" class="empty-state">此截点尚无已维护计划，所有版本均为待维护。</td></tr>'}</tbody></table></div><div class="table-footer">已冻结销量参考数据：${esc(d.meta?.data_through||s.meta?.data_through||'见快照导出')} · 不随之后刷新改变</div></div>`;
}
function snapshotProducts(d) {
  const prods=[...(d.products||[])],ids=new Set(prods.map(p=>p.id));
  for(const plan of d.plans||[])if(!ids.has(plan.product_id)){
    prods.push({id:plan.product_id,brand:'未归类',model:'历史版本',version:plan.product_id});ids.add(plan.product_id);
  }
  return prods;
}
function snapshotRows(d) {
  const saved=new Map((d.plans||[]).map(r=>[key(r.product_id,r.month),r]));
  const visible=[...new Set([...(d.meta?.months||[]),...(d.plans||[]).map(r=>r.month)])].sort();
  return snapshotProducts(d).flatMap(p=>visible.map(month=>saved.get(key(p.id,month))||{product_id:p.id,month,forecast:null,sop:null,owner:'',notes:''}));
}
async function compareSnapshots() {
  const left=$('#snapshot-left').value,right=$('#snapshot-right').value;
  if(!left||!right||left===right)return toast('请选择两份不同的快照',true);
  comparison=await api(`/api/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
  const changed=comparison.items.filter(v=>v.forecast_before!==v.forecast_after||v.sop_before!==v.sop_after);
  $('#comparison-result').className='';$('#comparison-result').innerHTML=changed.length?`<p class="form-help">${changed.length} 项数量发生变化</p><div class="table-scroll"><table class="detail-table"><thead><tr><th>版本 / 月份</th><th>预测 前→后</th><th>SOP 前→后</th></tr></thead><tbody>${changed.map(v=>{const p=state.products.find(x=>x.id===v.product_id);return `<tr><td>${esc(p?.model||'')} ${esc(p?.version||v.product_id)}<small>${v.month}</small></td><td>${fmt(v.forecast_before)} → ${fmt(v.forecast_after)}</td><td>${fmt(v.sop_before)} → ${fmt(v.sop_after)}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty-state compact">两份快照的计划数量没有变化。</div>';
}
