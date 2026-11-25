function optionMonths() {
  return optionRange==='rolling'
    ? Array.from({length:12},(_,i)=>shift(state.current_month,i-5))
    : yearMonths(optionYear);
}
function optionProductGroups() {
  const groups=new Map();
  for(const product of state.products||[]) {
    const id=modelGroupKey(product);
    if(!groups.has(id))groups.set(id,{id,brand:product.brand,model:product.model,products:[]});
    groups.get(id).products.push(product);
  }
  return [...groups.values()].sort((a,b)=>compareBrands(a.brand,b.brand)||a.model.localeCompare(b.model,'zh-CN'));
}
function optionMemberGroups(parent,sourceFor) {
  const groups=new Map(),generation=optionGeneration(parent,sourceFor);
  if(!generation)return [];
  for(const product of memberData().products||[]) {
    if(product.parent_generation!==generation)continue;
    const id=modelGroupKey(product);
    if(!groups.has(id))groups.set(id,{id,brand:product.brand,model:product.model,products:[],parent});
    groups.get(id).products.push(product);
  }
  return [...groups.values()].sort((a,b)=>a.model.localeCompare(b.model,'zh-CN'));
}
function optionPlanQuantity(group,month) {
  if(group.parent&&group.parent.products.some(p=>isModelPlan(p)&&planIndex.get(key(p.id,month))?.sop!=null))return null;
  return sumPlan(group.products,month,'sop').value;
}
// Match the source reader's NFKC, whitespace and explicit BETA aliases.
function optionGenerationKey(value) {
  return String(value||'').normalize('NFKC')
    .replace(/(20\d{2}款)\s*BETA(?=$|[\s_\-–—]|汇总$)/gi,'$1')
    .replace(/[\s_\-–—]*[(\[{]\s*BETA\s*[)\]}][\s_\-–—]*/gi,' ')
    .replace(/(^|[\s_\-–—])BETA(?=$|[\s_\-–—])[\s_\-–—]*/gi,' ')
    .trim().replace(/\s+/g,' ');
}
function optionSourceIndex() {
  const exact=new Map(),aliases=new Map();
  function entry(row) {
    if(!exact.has(row.generation)) {
      const source={generation:row.generation,groups:new Map()};
      const alias=row.normalized_generation||optionGenerationKey(row.generation);
      exact.set(row.generation,source);
      aliases.set(alias,aliases.has(alias)?null:source);
    }
    return exact.get(row.generation);
  }
  for(const row of optionMix?.rows||[]) {
    const {groups}=entry(row);
    if(row.is_vehicle_option!==true)continue;
    if(!groups.has(row.dimension))groups.set(row.dimension,[]);
    groups.get(row.dimension).push(row);
  }
  for(const issue of [...(optionMix?.missing_summaries||[]),...(optionMix?.issues||[])]) {
    if(!issue.source_cell)entry(issue).error=issue.source_sheet?`${issue.source_sheet} · ${issue.error}`:issue.error;
  }
  return name=>exact.get(name)||aliases.get(optionGenerationKey(name));
}
function optionGeneration(group,sourceFor) {
  const summaries=[...new Set(group.products.map(p=>p.summary_generation).filter(Boolean))];
  if(summaries.length)return summaries.length===1?summaries[0]:'';
  const generations=[...new Set(group.products.flatMap(productGenerations).filter(Boolean))];
  if(generations.length===1)return generations[0];
  if(generations.length) {
    const matches=new Set(generations.map(sourceFor));
    return matches.size===1?([...matches][0]?.generation||''):'';
  }
  const inferred=`${group.brand} ${group.model}`;
  return sourceFor(inferred)?inferred:'';
}
function optionNameKey(value) { return String(value||'').replace(/^\s*\d{4}款\s*/i,'').replace(/[\s·・]/g,'').toLowerCase(); }
function optionShareDisplay(item) { return item.share_display??(item.share==null?'':`${(item.share*100).toFixed(2)}%`); }
function optionAllocation(group,dimension,items,month) {
  const plan=optionPlanQuantity(group,month);
  if(plan==null)return {values:items.map(()=>null)};
  if(!Number.isSafeInteger(plan)||plan<0)return {error:'SOP计划量不是非负整数'};
  const keys=items.map(item=>optionNameKey(item.option));
  if(new Set(keys).size!==keys.length)return {error:'原表选配项名称重复'};
  const modelTotal=group.products.some(p=>isModelPlan(p)&&planValue(p,month,'sop')!=null);
  const versionPlans=dimension==='版本'?group.products.filter(p=>!isModelPlan(p)&&!p.read_only&&planValue(p,month,'sop')!=null):[];
  if(versionPlans.length&&!modelTotal) {
    const byName=new Map();
    for(const p of versionPlans) {
      const name=optionNameKey(p.configuration||p.version);
      if(keys.includes(name))byName.set(name,(byName.get(name)||0)+planValue(p,month,'sop'));
    }
    return {values:keys.map(name=>byName.has(name)?byName.get(name):null),manual:true};
  }
  if(items.some(item=>typeof item.share!=='number'||!Number.isFinite(item.share)||item.share<0||item.share>1))return {error:'原表比例存在空白或无效值'};
  const shareTotal=items.reduce((sum,item)=>sum+item.share,0);
  if(Math.abs(shareTotal-1)>0.005)return {error:`原表比例合计 ${Number((shareTotal*100).toFixed(2))}%，未拆分`};
  // The displayed source shares stay unchanged; only their tiny rounding drift
  // is reconciled while allocating an integer plan across exclusive options.
  const exact=items.map(item=>plan*item.share/shareTotal),values=exact.map(value=>Math.floor(value+1e-9));
  const remainder=plan-values.reduce((sum,value)=>sum+value,0);
  if(remainder<0||remainder>items.length)return {error:'原表比例与计划总量无法按整数守恒'};
  const order=exact.map((value,index)=>({index,fraction:value-values[index]}))
    .sort((a,b)=>b.fraction-a.fraction||a.index-b.index);
  for(let i=0;i<remainder;i++)values[order[i].index]++;
  return {values,modelTotal};
}
function optionAnnual(group,dimension,items,year,index) {
  const results=yearMonths(year).map(month=>optionAllocation(group,dimension,items,month));
  if(results.some(result=>result.error))return '';
  const values=results.map(result=>result.values[index]).filter(value=>value!=null);
  return values.length?fmt(values.reduce((sum,value)=>sum+value,0)):'';
}
function optionManualVersionRows(group,generation,items,visible,rolling) {
  const sourceKeys=new Set(items.map(item=>optionNameKey(item.option))),manual=new Map();
  for(const p of group.products) {
    if(isModelPlan(p)||p.read_only)continue;
    const id=optionNameKey(p.configuration||p.version);
    if(!manual.has(id))manual.set(id,{name:p.version,products:[]});
    manual.get(id).products.push(p);
  }
  const valueAt=(entry,month,unlisted)=>{
    const override=group.products.some(p=>isModelPlan(p)&&planValue(p,month,'sop')!=null);
    if(!unlisted&&!override)return null;
    const values=entry.products.map(p=>planValue(p,month,'sop')).filter(value=>value!=null);
    return values.length?values.reduce((sum,value)=>sum+value,0):null;
  };
  const annual=(entry,year,unlisted)=>{const values=yearMonths(year).map(month=>valueAt(entry,month,unlisted)).filter(v=>v!=null);return values.length?fmt(values.reduce((sum,v)=>sum+v,0)):'';};
  let html='';
  for(const [id,entry] of manual) {
    const unlisted=!sourceKeys.has(id);
    if(!visible.some(month=>valueAt(entry,month,unlisted)!=null)&&!(rolling?visible.filter(month=>month.endsWith('-12')).some(month=>annual(entry,month.slice(0,4),unlisted)):annual(entry,optionYear,unlisted)))continue;
    const cells=visible.map(month=>`<td class="number${month<state.current_month?' past-month':''}" title="人工版本计划${unlisted?'，原表无此选项':'，车型总量优先'}">${valueAt(entry,month,unlisted)==null?'':fmt(valueAt(entry,month,unlisted))}</td>${rolling&&month.endsWith('-12')?`<td class="number annual-total">${annual(entry,month.slice(0,4),unlisted)}</td>`:''}`).join('');
    html+=`<tr class="option-item-row option-manual-row" data-option-generation="${esc(generation)}" data-option-dimension="版本" data-option-name="${esc(entry.name)}" data-option-manual="true"><th scope="row" class="option-name">${esc(entry.name)}<small>人工计划${unlisted?' · 原表无比例':' · 车型量优先'}</small></th><td class="option-share"></td>${cells}${rolling?'':`<td class="number annual-total">${annual(entry,optionYear,unlisted)}</td>`}</tr>`;
  }
  return html;
}
function optionPageRender() {
  if(optionMixError){$('#app').innerHTML=pageHeading('option-split')+`<section class="card empty-state" role="alert"><strong>${esc(optionMixError)}</strong>${button('重新读取','retry-option-mix','small')}</section>`;return;}
  const all=optionProductGroups();
  const dimensions=[...new Set((optionMix?.rows||[]).filter(row=>row.is_vehicle_option===true).map(row=>row.dimension))];
  if(optionDimension&&!dimensions.includes(optionDimension))optionDimension='';
  const years=planYears();optionYear=years.includes(optionYear)?optionYear:state.current_month.slice(0,4);
  const visible=optionMonths(),rolling=optionRange==='rolling';
  const selected=all.filter(group=>(!optionBrand||group.brand===optionBrand)&&(!optionModel||group.id===optionModel)&&(!!optionModel||visible.some(month=>optionPlanQuantity(group,month)!=null)));
  const yearCell=year=>`<th scope="col" class="annual-total calendar-plan">${year}总计</th>`;
  const headers=visible.map(month=>`<th scope="col" class="${month<state.current_month?'past-month':''}">${shortMonth(month)}</th>${rolling&&month.endsWith('-12')?yearCell(month.slice(0,4)):''}`).join('')+(rolling?'':`<th scope="col" class="annual-total">${optionYear}总计</th>`);
  const yearPlan=(group,year)=>{const values=yearMonths(year).map(month=>optionPlanQuantity(group,month)).filter(v=>v!=null);return values.length?fmt(values.reduce((sum,v)=>sum+v,0)):'';};
  const planCells=group=>visible.map(month=>`<td class="number${month<state.current_month?' past-month':''}">${fmt(optionPlanQuantity(group,month))}</td>${rolling&&month.endsWith('-12')?`<td class="number annual-total">${yearPlan(group,month.slice(0,4))}</td>`:''}`).join('')+(rolling?'':`<td class="number annual-total">${yearPlan(group,optionYear)}</td>`);
  const sourceFor=optionSourceIndex();
  const fullColumns=visible.length+2+(rolling?visible.filter(month=>month.endsWith('-12')).length:1);
  const renderGroup=(group,member=false)=>{
    const generation=optionGeneration(group,sourceFor),sourceEntry=sourceFor(generation);
    const dimensionGroups=sourceEntry?.groups,name=member?generation:`${group.brand} · ${group.model}`;
    const children=member?[]:optionMemberGroups(group,sourceFor);
    const source=dimensionGroups?.values().next().value?.[0];
    const sourceMeta=source?.latest_date?`<small class="option-sample">${esc(source.latest_date)} · ${Number(source.covered_days)||0}/28天</small>`:'';
    const expand=children.length?`<button type="button" class="option-expand" data-option-expand="${esc(group.id)}" aria-label="${optionExpanded.has(group.id)?'收起':'展开'}${esc(name)}的单代际" aria-expanded="${optionExpanded.has(group.id)}">${optionExpanded.has(group.id)?'−':'+'}</button>`:'';
    let html=`<tr class="option-model-row${member?' option-member-row':''}" data-option-generation="${esc(generation)}"><th scope="row" class="option-name">${expand}${esc(name)}${sourceMeta}</th><td class="option-share">SOP计划量</td>${planCells(group)}</tr>`;
    if(!generation||!dimensionGroups?.size) {
      const reason=sourceEntry?.error?`${generation}：${sourceEntry.error}`:`原表缺少“${generation||name}”的直接近28天选配比例`;
      const manual=(!optionDimension||optionDimension==='版本')?optionManualVersionRows(group,generation,[],visible,rolling):'';
      return html+`<tr class="option-source-error" data-option-generation="${esc(generation)}"><td colspan="${fullColumns}">${esc(reason)}</td></tr>`+(manual?`<tr class="option-dimension-row" data-option-dimension="版本"><th scope="row" class="option-name">版本</th><td class="option-share"></td><td colspan="${fullColumns-2}"></td></tr>${manual}`:'');
    }
    if(optionDimension&&!dimensionGroups.has(optionDimension))html+=`<tr class="option-source-error" data-option-generation="${esc(generation)}"><td colspan="${fullColumns}">${esc(generation)} 原表缺少“${esc(optionDimension)}”比例</td></tr>`;
    for(const [dimension,items] of dimensionGroups) {
      if(optionDimension&&optionDimension!==dimension)continue;
      const monthResults=visible.map(month=>optionAllocation(group,dimension,items,month));
      const issue=monthResults.find(result=>result.error)?.error;
      const manual=dimension==='版本'&&monthResults.some(result=>result.manual);
      const overridden=dimension==='版本'&&visible.some(month=>group.products.some(p=>!isModelPlan(p)&&!p.read_only&&planValue(p,month,'sop')!=null)&&group.products.some(p=>isModelPlan(p)&&planValue(p,month,'sop')!=null));
      html+=`<tr class="option-dimension-row${member?' option-member-row':''}" data-option-generation="${esc(generation)}" data-option-dimension="${esc(dimension)}"><th scope="row" class="option-name">${esc(dimension)}${manual?'<small>已维护版本计划</small>':overridden?'<small>车型量优先</small>':''}</th><td class="option-share"></td><td colspan="${fullColumns-2}">${issue?`<span class="option-source-error">${esc(issue)}</span>`:''}</td></tr>`;
      items.forEach((item,index)=>{
        const itemCells=visible.map((month,mIndex)=>{
          const {values,manual}=monthResults[mIndex],value=values?.[index];
          return `<td class="number${month<state.current_month?' past-month':''}"${manual?' title="已维护版本计划"':''}>${value==null?'':fmt(value)}</td>${rolling&&month.endsWith('-12')?`<td class="number annual-total">${optionAnnual(group,dimension,items,month.slice(0,4),index)}</td>`:''}`;
        }).join('');
        const annual=rolling?'':`<td class="number annual-total">${optionAnnual(group,dimension,items,optionYear,index)}</td>`;
        const sourceCell=`${item.source_sheet||`${item.source_generation||generation}by天`}!${item.source_cell||''}`;
        const share=optionShareDisplay(item);
        html+=`<tr class="option-item-row${member?' option-member-row':''}" data-option-generation="${esc(generation)}" data-option-dimension="${esc(dimension)}" data-option-name="${esc(item.option)}"><th scope="row" class="option-name">${esc(item.option)}</th><td class="option-share" title="${esc(sourceCell)}">${esc(share)}</td>${itemCells}${annual}</tr>`;
      });
      if(dimension==='版本')html+=optionManualVersionRows(group,generation,items,visible,rolling);
    }
    if(!dimensionGroups.has('版本')&&(!optionDimension||optionDimension==='版本')) {
      const manual=optionManualVersionRows(group,generation,[],visible,rolling);
      if(manual)html+=`<tr class="option-dimension-row" data-option-generation="${esc(generation)}" data-option-dimension="版本"><th scope="row" class="option-name">版本</th><td class="option-share"></td><td colspan="${fullColumns-2}"><span class="option-source-error">原表缺少版本比例</span></td></tr>${manual}`;
    }
    return html;
  };
  const rows=selected.map(group=>renderGroup(group)+(optionExpanded.has(group.id)?optionMemberGroups(group,sourceFor).map(child=>renderGroup(child,true)).join(''):'')).join('');
  const status=optionMix?.latest_date?`选配截至 <strong>${esc(optionMix.latest_date)}</strong> · 近28天覆盖 <strong>${Number(optionMix.covered_days)||0}/28天</strong>`:'选配数据待更新';
  const freshness=optionMix?.status==='stale'||optionMix?.error?`<span class="option-source-error" title="${esc(optionMix.error||'选配来源待刷新')}">选配来源待刷新</span>`:'';
  const unclassified=optionMix?.unclassified_dimensions?.length??[...new Set((optionMix?.rows||[]).filter(row=>row.is_vehicle_option==null).map(row=>row.dimension))].length;
  $('#app').innerHTML=pageHeading('option-split')+`<div class="plan-controls option-controls"><div class="annual-toolbar"><div class="annual-filters"><label class="field inline-field">周期<select id="option-range">${opt('rolling','M+6（滚动12个月）',optionRange)}${opt('annual','全年',optionRange)}</select></label>${rolling?'':`<label class="field inline-field">年份<select id="option-year">${years.map(year=>opt(year,`${year}年`,optionYear)).join('')}</select></label>`}<label class="field inline-field">品牌<select id="option-brand">${opt('','全部品牌',optionBrand)}${[...new Set(all.map(group=>group.brand))].map(name=>opt(name,name,optionBrand)).join('')}</select></label><label class="field inline-field">车型<select id="option-model">${opt('','全部车型',optionModel)}${all.filter(group=>!optionBrand||group.brand===optionBrand).map(group=>opt(group.id,optionBrand?group.model:`${group.brand} · ${group.model}`,optionModel)).join('')}</select></label><label class="field inline-field">维度<select id="option-dimension">${opt('','全部维度',optionDimension)}${dimensions.map(name=>opt(name,name,optionDimension)).join('')}</select></label></div></div><div class="sheet-meta">${status}${freshness}${unclassified?`<span>待分类维度 <strong>${unclassified}</strong></span>`:''}</div></div><section class="card option-sheet" aria-label="选配拆分计划表"><div class="table-scroll" tabindex="0"><table class="option-table"><thead><tr><th scope="col" class="option-name">车型 / 选配项</th><th scope="col" class="option-share">原表近28天占比</th>${headers}</tr></thead><tbody>${rows||`<tr><td class="empty-state" colspan="${fullColumns}">${selected.length?'没有可拆分的选配维度':'当前周期没有计划量'}</td></tr>`}</tbody></table></div></section>`;
}
async function optionPage() {
  if(!optionMix&&!optionMixError) {
    $('#app').innerHTML=pageHeading('option-split')+'<div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span><strong>正在读取选配比例</strong></div>';
    const request=++optionRequestId;
    try { const fresh=await api('/api/option-mix');if(request!==optionRequestId)return;optionMix=fresh; }
    catch(error) { if(request!==optionRequestId)return;optionMixError=error.message; }
  }
  if(page==='option-split')optionPageRender();
}
