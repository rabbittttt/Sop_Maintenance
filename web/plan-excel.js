function exportableMonths() { return [...new Set([...planMonths(),...months()])].sort(); }
function maintenanceExportOptions() {
  return {includeLocks:false,includeVersions:true,includeWenjie:true,selectedMonths:planMonths(),allProducts:true};
}
function buildPlanExport({includeLocks=false,includeVersions=true,selectedMonths=[]}={},ps=products()) {
  if(generationViewError)throw new Error(generationViewError);
  const hierarchy=hierarchicalPlanning();
  ps=sortedProducts(ps);
  if(hierarchy&&includeVersions){const roots=ps.filter(p=>!p.read_only);ps=[...roots,...childProducts(roots)];}
  const allowed=new Set(exportableMonths());
  if(!Array.isArray(selectedMonths)||!selectedMonths.length)throw new Error('请至少选择一个导出月份');
  if(selectedMonths.some(m=>typeof m!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)||!allowed.has(m)))throw new Error('导出月份不在可选范围内');
  if(!ps.length)throw new Error('当前筛选范围没有可导出的车型或版本');
  const chosen=[...new Set(selectedMonths)].sort(),rows=[],annualPlans=[],rowProductIds=[],rowParentGenerations=[],groups=new Map();
  const annualYears=chosen.filter(m=>m.endsWith('-12')).map(m=>m.slice(0,4));
  ps.forEach(p=>{const id=hierarchy?modelGroupKey(p):JSON.stringify([p.brand,p.model]);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(p);});
  const fields=includeLocks?['locks','sop']:['sop'];
  let blocks=[...groups.values()];
  if(hierarchy){const roots=blocks.filter(group=>!group[0].parent_generation);blocks=roots.flatMap(group=>[group,...blocks.filter(child=>child[0].parent_generation&&group.some(p=>p.summary_generation===child[0].parent_generation))]);}
  for(const group of blocks) {
    const p=group[0],fullCount=allProducts().filter(x=>modelGroupKey(x)===modelGroupKey(p)).length;
    const append=(items,field,detail=false)=>{
      const notes=[],quantities=chosen.map(m=>field==='locks'?sumSales(items,m,salesIndex,!detail):detail&&items[0].summary_generation&&isModelPlan(items[0])?{value:planIndex.get(key(items[0].id,m))?.sop??null,known:planIndex.get(key(items[0].id,m))?.sop==null?0:1,total:1}:sumPlan(items,m,'sop'));
      if(detail&&allProducts().filter(x=>modelGroupKey(x)===modelGroupKey(p)&&x.version===items[0].version).length>1) {
        const version=items[0],source=version.source_generation||productGenerations(version).join('、')||'手工建立';
        notes.push(`同名版本来源：${source}；版本编码：${version.id}`);
      }
      if(!detail&&group.length<fullCount)notes.push(`仅汇总筛选的 ${group.length}/${fullCount} 个版本`);
      if(!detail&&includeVersions)notes.push('车型汇总与版本明细范围相同，请勿重复相加');
      if(field==='locks') {
        notes.push('锁单为来源月值，完整性以源表为准');
        if(quantities.some(q=>q.model_reference))notes.push('车型锁单取源表“交车锁单／数量”原值，不按版本重算');
        if(detail&&state.meta?.version_lock_basis==='source_version_quantity')notes.push('版本锁单取源表“版本／数量”原值，与车型锁单分别记录');
        if(detail&&state.meta?.version_lock_basis==='model_lock_row')notes.push('源表仅有车型锁单时，版本锁单留空');
      }
      const describe=(test,label)=>{const ms=chosen.filter((m,i)=>test(quantities[i]));if(ms.length)notes.push(`${ms.join('、')}：${label}`);};
      describe(q=>q.total===0,'未适用');
      describe(q=>q.total>0&&q.value==null,field==='locks'?'锁单缺失，留空':'计划待维护，留空');
      describe(q=>q.value!=null&&(q.partial||q.known<q.total),'仅已知项合计，仍有缺项');
      describe(q=>q.reference_conflict,'新旧来源同月冲突，冲突部分未汇总');
      const annual={};
      for(const year of annualYears) {
        const total=annualQuantity(items,yearMonths(year),field,!detail);
        annual[year]=total?.value??null;
        if(field==='sop'&&total?.value!=null&&!total.complete)notes.push(`${year}年度计划仅含已知值，${total.knownMonths}/${total.totalMonths}个月有数据${total.partial?'，版本仍有缺项':''}`);
      }
      rows.push([detail?'版本明细':'车型汇总',p.brand,p.model,...(includeVersions?[detail?items[0].version:'']:[]),field==='locks'?'锁单数':'SOP计划量',...quantities.map(q=>q.value),notes.join('；')]);
      annualPlans.push(annual);
      rowProductIds.push(detail?items[0].id:null);
      rowParentGenerations.push(p.parent_generation||null);
    };
    fields.forEach(field=>append(group,field));
    if(includeVersions)fields.forEach(field=>group.filter(product=>field!=='locks'||!isModelPlan(product)).forEach(product=>append([product],field,true)));
  }
  return {headers:['层级','品牌','车型',...(includeVersions?['版本']:[]),'指标',...chosen,'数据说明'],rows,selectedMonths:chosen,annualPlans,rowProductIds,selectedProductIds:ps.map(p=>p.id),...(hierarchy?{rowParentGenerations}:{})};
}
function exportProducts(options) { return products({includeWenjie:options.includeWenjie??showWenjie,applyFilters:!options.allProducts}); }
function exportScope(options) {
  const scope=options.allProducts?'全部品牌 · 全部车型':[brand||'全部品牌',model||'全部车型',query?`搜索“${query}”`:''].filter(Boolean).join(' · ');
  return scope+((options.includeWenjie??showWenjie)?'':'（不含问界）')+(hierarchicalPlanning()?'':' · '+generationModeLabel());
}
async function downloadPlanExport(options) {
  const result=buildPlanExport(options,exportProducts(options)),chosen=result.selectedMonths,includeVersions=result.headers.includes('版本');
  const scope=exportScope(options);
  const response=await serviceFetch('/api/plans/export-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    schema_version:1,current_month:state.current_month,months:chosen,include_locks:!!options.includeLocks,include_versions:includeVersions,
    ...(state.generation_view?{generation_mode:generationMode(),generation_rule_signature:state.generation_view.rule_signature}:{}),
    scope,headers:result.headers,rows:result.rows,annual_plans:result.annualPlans,row_product_ids:result.rowProductIds,selected_product_ids:result.selectedProductIds,...(result.rowParentGenerations?{row_parent_generations:result.rowParentGenerations}:{})
  })});
  if(!response.ok){let message='Excel导出未完成，请重试';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
  const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`SOP计划_${chosen[0]}_${chosen.at(-1)}_${chosen.length}个月_${includeVersions?'版本明细':'车型汇总'}.xlsx`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  toast(`已导出所选 ${chosen.length} 个月的Excel${options.includeLocks?'（含锁单）':''}`);
  return result;
}
function exportPlans(kind='sop') {
  if(kind==='demand')return exportDemandPlans();
  const defaults=maintenanceExportOptions(),maintenance=new Set(defaults.selectedMonths),available=exportableMonths(),current=new Set(months());
  const years=[...new Set(available.map(m=>m.slice(0,4)))],hasFilter=!!(brand||model||query);
  openDialog(`<form id="export-plan-form"><h2>导出Excel</h2>${excelKindSelector('sop')}<p id="export-scope" class="subtitle"></p><div id="export-error" class="inline-error" role="alert"></div><fieldset class="export-content-options"><legend>导出内容</legend><label class="export-check"><input type="checkbox" id="export-wenjie" checked><span>包含问界</span></label><label class="export-check"><input type="checkbox" id="export-locks"><span>增加锁单行</span></label><label class="export-check"><input type="checkbox" id="export-versions" checked><span>${hierarchicalPlanning()?'包含单代际及版本明细':generationMode()==='summary'?'包含版本明细（只读）':'包含版本明细'}</span></label>${hasFilter?'<label class="export-check"><input type="checkbox" id="export-filtered"><span>仅导出当前筛选</span></label>':''}</fieldset><div class="export-month-heading"><h3>导出月份</h3><div class="toolbar"><button type="button" class="button ghost small" data-export-preset="maintenance">恢复完整模板</button><button type="button" class="button ghost small" data-export-months="current">当前视图</button><button type="button" class="button ghost small" data-export-months="all">全部月份</button><button type="button" class="button ghost small" data-export-months="none">清空</button></div></div><div class="export-month-list">${years.map(y=>`<fieldset class="export-month-year"><legend>${y}年</legend><div class="export-month-grid">${available.filter(m=>m.startsWith(y+'-')).map(m=>`<label class="export-check"><input type="checkbox" name="export-month" value="${m}" aria-label="${y}年${Number(m.slice(5))}月" ${maintenance.has(m)?'checked':''}><span>${Number(m.slice(5))}月</span></label>`).join('')}</div></fieldset>`).join('')}</div><p id="export-selection" class="export-selection" role="status"></p><div class="dialog-actions">${button('取消','close-dialog')}<button type="submit" class="button primary">导出维护模板</button></div></form>`);
  $('#excel-kind').onchange=e=>exportPlans(e.target.value);
  const form=$('#export-plan-form'),monthInputs=$$('input[name="export-month"]',form),save=$('button[type="submit"]',form);
  const versionOption=$('#export-versions',form),lockOption=$('#export-locks',form),wenjieOption=$('#export-wenjie',form),filterOption=$('#export-filtered',form);
  const reset=()=>{
    versionOption.checked=defaults.includeVersions;lockOption.checked=defaults.includeLocks;wenjieOption.checked=defaults.includeWenjie;
    if(filterOption)filterOption.checked=false;
    monthInputs.forEach(input=>input.checked=maintenance.has(input.value));
  };
  const update=(clearError=true)=>{
    const selectedMonths=monthInputs.filter(el=>el.checked).map(el=>el.value),count=selectedMonths.length,versions=versionOption.checked;
    const options={allProducts:!filterOption?.checked,includeWenjie:wenjieOption.checked},ps=exportProducts(options),scope=exportScope(options);
    const template=versions&&!lockOption.checked&&wenjieOption.checked&&!filterOption?.checked&&count===maintenance.size&&selectedMonths.every(m=>maintenance.has(m));
    $('#export-scope',form).textContent=`${scope} · ${new Set(ps.map(p=>JSON.stringify([p.brand,p.model]))).size} 个车型 / ${ps.length} 个版本`;
    $('#export-selection',form).textContent=count?`已选 ${count} 个月`:'请至少选择一个月份';
    save.textContent=template?'导出维护模板':versions?'导出版本计划':'导出车型计划';
    save.disabled=!count||!ps.length;
    if(clearError)$('#export-error',form).textContent=ps.length?'':'当前筛选范围没有可导出的车型或版本';
  };
  $('[data-export-preset="maintenance"]',form).onclick=()=>{reset();update();};
  $$('[data-export-months]',form).forEach(el=>el.onclick=()=>{monthInputs.forEach(input=>input.checked=el.dataset.exportMonths==='all'||(el.dataset.exportMonths==='current'&&current.has(input.value)));update();});
  [...monthInputs,versionOption,lockOption,wenjieOption,...(filterOption?[filterOption]:[])].forEach(el=>el.onchange=()=>update());
  form.onsubmit=async e=>{
    e.preventDefault();if(form.getAttribute('aria-busy')==='true')return;
    const options={includeLocks:lockOption.checked,includeVersions:versionOption.checked,includeWenjie:wenjieOption.checked,selectedMonths:monthInputs.filter(el=>el.checked).map(el=>el.value),allProducts:!filterOption?.checked};
    const controls=$$('input,select,button',form),previous=controls.map(el=>el.disabled);
    form.setAttribute('aria-busy','true');controls.forEach(el=>el.disabled=true);save.textContent='正在生成Excel…';$('#export-error',form).textContent='';
    try{await downloadPlanExport(options);if($('#export-plan-form')===form)closeDialog();}
    catch(err){if($('#export-plan-form')===form)$('#export-error',form).textContent=err.message;else toast(err.message,true);}
    finally{form.removeAttribute('aria-busy');controls.forEach((el,i)=>el.disabled=previous[i]);if($('#export-plan-form')===form)update(false);}
  };
  reset();
  wenjieOption.checked=showWenjie;
  update();
}
const MAX_PLAN_IMPORT_BYTES=12*1024*1024;
function validatePlanImportFile(file) {
  if(!file)throw new Error('请先选择修改后的Excel文件');
  if(!/\.xlsx$/i.test(file.name))throw new Error('请选择 .xlsx 格式的SOP计划表');
  if(!file.size)throw new Error('文件为空，请重新保存Excel后选择');
  if(file.size>MAX_PLAN_IMPORT_BYTES)throw new Error('文件不能超过12MB，请缩小导出月份或版本范围');
  return file;
}
async function readPlanImportFile(file) {
  validatePlanImportFile(file);
  const content_base64=await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{const encoded=String(reader.result||'').split(',')[1];encoded?resolve(encoded):reject(new Error('无法读取文件内容，请重新选择'));};
    reader.onerror=()=>reject(new Error('读取文件失败，请确认Excel已保存后重试'));
    reader.onabort=()=>reject(new Error('文件读取已取消，请重新选择'));
    reader.readAsDataURL(file);
  });
  return {filename:file.name,content_base64};
}
async function submitPlanImport(payload,choice,confirmationToken) {
  if(choice!==undefined&&!['db','workbook'].includes(choice))throw new Error('请选择冲突项的处理方式');
  const body={filename:payload.filename,content_base64:payload.content_base64,...(choice?{choice,confirmation_token:confirmationToken}:{})};
  const response=await serviceFetch('/api/plans/import-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let data;
  try{data=await response.json();}catch{throw new Error('未能确认导入结果，请刷新看板检查后重试');}
  if(!response.ok){const fallback=response.status===409?'表格与网页存在同时修改的计划，请核对后选择保留值':`导入未完成（${response.status}）`;const error=new Error(data.error||data.message||fallback);error.status=response.status;error.data=data;throw error;}
  return data;
}
function planConflictTableHtml(conflicts) {
  const unknownBaseline=conflicts.some(c=>c.baseline_unknown);
  return `<div class="table-scroll import-conflict-table"><table class="detail-table"><thead><tr><th>车型 / 版本 / 月份</th><th>${unknownBaseline?'原表基准':'导出时'}</th><th>Excel修改值</th><th>网页当前值</th></tr></thead><tbody>${conflicts.map(c=>{const p=allProducts().find(p=>p.id===c.product_id)||c;return `<tr><td>${esc(p.brand)} ${esc(p.model)}<small>${esc(p.version||c.product_id)} · ${esc(conflictField(c))}${c.reason==='plans_changed'?'（导出后计划已更新）':''}</small></td><td>${c.baseline_unknown?'未提供':conflictValue(c)(c.baseline)}</td><td>${conflictValue(c)(c.workbook)}</td><td>${conflictValue(c)(c.database)}</td></tr>`;}).join('')}</tbody></table></div>`;
}
function planImportConflictsHtml(conflicts) {
  return `${planConflictTableHtml(conflicts)}<p class="form-help">${conflicts.some(c=>c.baseline_unknown)?'表格计划与网页当前值不一致，请选择保留网页值或采用表格值。':'两边都修改了以上单元格。选择仅作用于这些冲突项，其余修改正常合并。'}</p><div class="dialog-actions import-conflict-actions"><button type="button" class="button secondary" data-import-choice="db">冲突项保留网页值</button><button type="button" class="button primary" data-import-choice="workbook">冲突项采用Excel值</button></div>`;
}
function excelKindSelector(kind){return `<label class="field">计划类型<select id="excel-kind">${opt('sop','SOP计划',kind)}${opt('demand','要货计划',kind)}</select></label>`;}
function exportDemandPlans(){
  const available=exportableMonths();
  openDialog(`<form id="export-plan-form"><h2>导出Excel</h2>${excelKindSelector('demand')}<div class="form-grid"><label class="field">开始月份<select id="demand-from">${available.map(m=>opt(m,shortMonth(m),available[0])).join('')}</select></label><label class="field">结束月份<select id="demand-to">${available.map(m=>opt(m,shortMonth(m),available.at(-1))).join('')}</select></label></div><label class="checkbox-field"><input id="demand-filtered" type="checkbox">仅当前筛选车型</label><div id="demand-error" class="inline-error" role="alert"></div><div class="dialog-actions">${button('取消','close-dialog')}<button type="submit" class="button primary">导出Excel</button></div></form>`);
  $('#excel-kind').onchange=e=>exportPlans(e.target.value);
  $('#export-plan-form').onsubmit=async e=>{
    e.preventDefault();const form=e.target,save=$('button[type="submit"]',form);save.disabled=true;
    try{
      const start=$('#demand-from').value,end=$('#demand-to').value;
      if(start>end)throw new Error('结束月份不能早于开始月份');
      const months=available.filter(m=>m>=start&&m<=end),models=$('#demand-filtered').checked?[...new Map(products().map(p=>[modelGroupKey(p),{brand:p.brand,model:p.model}])).values()]:undefined;
      const response=await serviceFetch('/api/demand/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({months,...(models?{models}:{})})});
      if(!response.ok){const error=await response.json();throw new Error(error.error||'导出失败');}
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=`要货计划_${start}_${end}.xlsx`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);closeDialog();toast('要货计划已导出');
    }catch(error){$('#demand-error').textContent=error.message;}finally{save.disabled=false;}
  };
}
function importPlans(kind='sop') {
  openDialog(`<form id="import-plan-form"><h2>导入Excel</h2>${excelKindSelector(kind)}<div id="import-error" class="inline-error" role="alert" tabindex="-1"></div><label class="field import-file-field">Excel文件（.xlsx，最大 12 MB）<input id="import-plan-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label><p id="import-progress" class="import-progress" role="status" aria-live="polite"></p><div id="import-conflicts"></div><div class="dialog-actions">${button('取消','close-dialog')}<button id="import-save" type="submit" class="button primary" disabled>导入计划</button></div></form>`);
  const form=$('#import-plan-form'),input=$('#import-plan-file'),save=$('#import-save'),error=$('#import-error'),progress=$('#import-progress'),conflicts=$('#import-conflicts'),dialog=$('#edit-dialog'),close=$('[data-close]',dialog);
  let prepared=null,pending=false,valid=false,hasConflicts=false,confirmationToken=null;
  let demandBase=state.demand_revision;$('#excel-kind').onchange=e=>importPlans(e.target.value);
  const cancel=e=>{if(pending)e.preventDefault();};
  dialog.addEventListener('cancel',cancel);
  dialog.addEventListener('close',()=>dialog.removeEventListener('cancel',cancel),{once:true});
  const showError=message=>{error.textContent=message;error.focus();};
  const setBusy=busy=>{pending=busy;form.setAttribute('aria-busy',String(busy));$$('input,select,button',form).forEach(el=>el.disabled=busy);close.disabled=busy;save.disabled=busy||!valid;save.hidden=hasConflicts;save.textContent=busy?'正在导入…':'导入计划';progress.textContent=busy?'正在检查表格并合并计划，请稍候…':'';};
  input.onchange=()=>{
    prepared=null;confirmationToken=null;valid=false;hasConflicts=false;conflicts.innerHTML='';error.textContent='';
    try{validatePlanImportFile(input.files[0]);valid=true;}catch(err){if(input.files.length)showError(err.message);}
    setBusy(false);
  };
  const submit=async choice=>{
    if(pending)return;
    error.textContent='';setBusy(true);
    try{
      prepared||=await readPlanImportFile(input.files[0]);
      const result=kind==='demand'?await api('/api/demand/import',{...prepared,base_revision:demandBase,owner:access.user||owner}):await submitPlanImport(prepared,choice,confirmationToken);
      if(kind==='demand'){showDemand=true;writeBrowserPreference(demandPreferenceKey,'true');}
      closeDialog();
      const message=result.imported||result.created||result.catalog_updated?`已导入 ${result.imported||0} 项计划${result.created?`，新增 ${result.created} 行`:''}${result.catalog_updated?`，更新 ${result.catalog_updated} 个版本`:''}${result.deactivated?`（其中停用 ${result.deactivated} 个）`:''}`:'计划已核对，没有需要导入的新修改';
      try{await load();toast(result.warning?`${message}；${result.warning}`:message,!!result.warning);}catch{toast(`${message}；页面刷新失败，请点击刷新查看${result.warning?`。${result.warning}`:''}`,true);}
    }catch(err){
      if($('#import-plan-form')!==form){toast(err.message,true);return;}
      if(err.status===400){
        prepared=null;confirmationToken=null;input.value='';valid=false;hasConflicts=false;conflicts.innerHTML='';
        showError(`${err.message}\n请保存Excel后重新选择文件导入。`);return;
      }
      if(err.status===409&&kind==='demand'&&err.data?.reload_workbook){
        prepared=null;input.value='';valid=false;hasConflicts=false;conflicts.innerHTML='';
      }else if(err.status===409&&kind==='demand'){
        hasConflicts=true;
        conflicts.innerHTML='<div class="dialog-actions"><button type="button" class="button secondary" id="demand-recheck">刷新后重新核对</button></div>';
        $('#demand-recheck').onclick=async()=>{
          if(pending)return;
          setBusy(true);
          try{await load(false);demandBase=state.demand_revision;hasConflicts=false;conflicts.innerHTML='';showError('已刷新当前要货计划。请核对后再次点击导入计划；表格非空值将覆盖相同车型和月份。');}
          catch(refreshError){showError(refreshError.message);}
          finally{setBusy(false);}
        };
      }else if(err.status===409&&Array.isArray(err.data?.conflicts)&&err.data.conflicts.length){
        hasConflicts=true;confirmationToken=err.data.confirmation_token;conflicts.innerHTML=planImportConflictsHtml(err.data.conflicts);
        $$('[data-import-choice]',conflicts).forEach(el=>el.onclick=()=>submit(el.dataset.importChoice));
      }
      showError(err.message);
    }finally{setBusy(false);}
  };
  form.onsubmit=e=>{e.preventDefault();return submit();};
}
