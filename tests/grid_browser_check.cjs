/* Run with Node, an optional absolute path to Playwright and an optional origin.
 * Use http://sop-grid.test to cover insecure intranet HTTP without randomUUID.
 * All routes use synthetic data; no local service or business file is accessed.
 */
const {chromium} = require(process.argv[2] || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output_file/grid-check');
const origin = process.argv[3] || 'http://127.0.0.1:18877';

function fixture(mode='detail') {
  const product=(id,brand,model,version)=>({id,brand,model,version,catalog_model:model.replace(/ 20\d\d款$/,''),
    generation:brand+' '+model,source_generation:brand+' '+model,source_generations:[brand+' '+model],
    revision:1,active:true,start_month:'2026-01',end_month:null});
  const members=[product('a','享界','S9 2026款','Max'),product('b','享界','S9 2026款','Ultra')];
  const summaryGeneration='享界 X4 2026款汇总';
  const data={current_month:'2026-10',plan_end:'2027-12',now:'2026-10-29T12:00:00+08:00',
    settings:{generation_mode:mode},generation_view:{mode,rule_signature:'fixture-rules',warnings:[]},
    meta:{quality:[],metrics:[]},workbook_sync:{status:'absent',message:'未建立维护表'},
    products:[product('x','智界','R7 2026款','Pro'),product('old','享界','S9 2024款','Max'),
      ...(mode==='summary'?[{...product('group','享界','X4 2026款','Max'),read_only:true,summary_generation:summaryGeneration,member_product_ids:['a','b']}]:members),
      product('w','问界','M5 2025款','Max')],
    plans:[{product_id:'a',month:'2026-10',sop:100,forecast:111,revision:1},
      {product_id:'a',month:'2026-11',sop:150,forecast:160,revision:1},
      {product_id:'b',month:'2026-10',sop:200,forecast:220,revision:1},
      {product_id:'old',month:'2026-10',sop:80,forecast:81,revision:1},
      {product_id:'x',month:'2026-10',sop:20,forecast:22,revision:1},
      {product_id:'w',month:'2026-10',sop:40,forecast:44,revision:1},
      {product_id:'group',month:'2026-10',sop:300,forecast:331,revision:0}],
    sales:[],model_sales:[],shipments:[],history_months:['2026-07','2026-08','2026-09']};
  if(mode==='summary'){
    const ids=new Set(members.map(member=>member.id));
    data.generation_members={
      products:members.map(member=>({...member,parent_generation:summaryGeneration})),
      plans:data.plans.filter(plan=>ids.has(plan.product_id)),
    };
    data.plans=data.plans.filter(plan=>!ids.has(plan.product_id));
  }
  return data;
}

async function main() {
  await fs.mkdir(out,{recursive:true});
  let state=fixture(),failure='',savedRequests=[],exportRequest=null,stateRequests=0,loseResponse=false;
  const mainAccount='CORP\\BrowserTest', otherAccount='CORP\\OtherTester';
  let sessionAccount=mainAccount, viewSequence=0;
  const viewsByAccount=new Map(), viewRequests=[];
  const personalViews=()=>{
    if(!viewsByAccount.has(sessionAccount))viewsByAccount.set(sessionAccount,{views:[],active:''});
    return viewsByAccount.get(sessionAccount);
  };
  const apiPaths=[];
  const completed=new Map();
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  let page;
  try {
    page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('sop-owner','浏览器测试'));
    const routeApp=async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/api/'))apiPaths.push(url.pathname);
      if(url.pathname==='/api/session')return route.fulfill({json:{mode:'console',user:sessionAccount,canWrite:true}});
      if(url.pathname==='/api/user-views'){
        const record=personalViews();
        if(route.request().method()==='GET')return route.fulfill({json:record});
        const request=route.request().postDataJSON();
        viewRequests.push({account:sessionAccount,request});
        if(request.action==='save'){
          const existing=record.views.find(view=>view.name===request.name);
          const view=existing||{id:String(++viewSequence),name:request.name};
          view.config=request.config;
          if(!existing)record.views.push(view);
          record.active=view.id;
        }else if(request.action==='select'||request.action==='delete'){
          if((request.id||request.action==='delete')&&!record.views.some(view=>view.id===request.id)){
            return route.fulfill({status:404,json:{error:'视图不存在'}});
          }
          if(request.action==='select')record.active=request.id;
          else{
            record.views=record.views.filter(view=>view.id!==request.id);
            if(record.active===request.id)record.active='';
          }
        }else if(request.action==='import'){
          let imported=0;
          for(const item of request.views){
            if(record.views.some(view=>view.name===item.name))continue;
            record.views.push({id:String(++viewSequence),name:item.name,config:item.config});
            imported++;
          }
          const chosen=request.views.find(view=>view.id===request.active);
          if(chosen&&!record.active)record.active=record.views.find(view=>view.name===chosen.name).id;
          return route.fulfill({json:{...record,imported}});
        }else{
          return route.fulfill({status:400,json:{error:'未知视图操作'}});
        }
        return route.fulfill({json:record});
      }
      if(url.pathname==='/api/state'){stateRequests++;return route.fulfill({json:state});}
      if(url.pathname==='/api/status')return route.fulfill({json:{status:'absent',generation_view:state.generation_view}});
      if(url.pathname==='/api/settings') {
        state=fixture(route.request().postDataJSON().generation_mode);
        return route.fulfill({json:{ok:true,settings:state.settings}});
      }
      if(url.pathname==='/api/plans/batch-edit') {
        const request=route.request().postDataJSON();savedRequests.push(request);
        if(failure)return route.fulfill({status:409,json:{error:failure}});
        if(completed.has(request.request_id))return route.fulfill({json:completed.get(request.request_id)});
        for(const change of request.changes||[]) {
          let row=state.plans.find(p=>p.product_id===change.product_id&&p.month===change.month);
          if(!row){row={product_id:change.product_id,month:change.month,forecast:null,revision:0};state.plans.push(row);}
          row.sop=change.sop;row.revision++;
        }
        for(const change of request.catalog_changes||[])Object.assign(state.products.find(p=>p.id===change.id),change);
        const entry_ids={};
        for(const entry of request.entries||[]) {
          const id='created-'+entry.client_id;entry_ids[entry.client_id]=id;
          state.products.push({...entry,id,active:true,revision:1,start_month:'2026-10'});
          for(const plan of entry.plans||[])state.plans.push({...plan,product_id:id,forecast:null,revision:1});
        }
        const result={ok:true,entry_ids,created_count:(request.entries||[]).length,saved_count:(request.changes||[]).length};
        completed.set(request.request_id,result);
        if(loseResponse){loseResponse=false;return route.abort('connectionreset');}
        return route.fulfill({json:result});
      }
      if(url.pathname==='/api/plans/export-xlsx') {
        exportRequest=route.request().postDataJSON();
        return route.fulfill({body:Buffer.from('PKtest'),contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      }
      if(url.pathname.startsWith('/api/'))throw new Error('Unexpected API: '+url.pathname);
      if(url.pathname==='/toolbar-fixture') return route.fulfill({contentType:'text/html',
        body:'<meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}iframe{display:block;width:100vw;height:100vh;border:0}</style><iframe title="SOP" src="/"></iframe>'});
      const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
      const contentType=name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.ico')?'image/x-icon':'text/html';
      return route.fulfill({body:await fs.readFile(path.join(root,'web',name)),contentType});
    };
    await page.route(`${origin}/**`,routeApp);
    if(process.argv.includes('--check-toolbar') || process.argv.includes('--update-toolbar')) {
      const update=process.argv.includes('--update-toolbar');
      const baseline=path.join(out,'toolbar-baseline');
      if(update)await fs.mkdir(baseline,{recursive:true});
      await page.goto(origin+'/toolbar-fixture');
      await page.evaluate(account => document.querySelector('iframe').contentWindow.postMessage(
        {account,roleCode:'test',roleName:'验收'},location.origin),mainAccount);
      const frame=page.frameLocator('iframe');
      for(const width of [1440,1000]) {
        await page.setViewportSize({width,height:900});
        for(const mode of ['browse','edit']) {
          const action=frame.locator('[data-action="bulk-plan"]');
          await action.waitFor();
          if(mode==='edit')await action.click();
          const filename='toolbar-'+width+'-'+mode+'.png';
          const image=await frame.locator('.plan-controls').screenshot({animations:'disabled',caret:'hide'});
          if(update)await fs.writeFile(path.join(baseline,filename),image);
          else {
            const expected=await fs.readFile(path.join(baseline,filename));
            if(!expected.equals(image)){
              await fs.writeFile(path.join(out,filename),image);
              throw new Error('工具栏与本机基准不同：'+filename);
            }
          }
          if(mode==='edit')await frame.locator('[data-action="grid-cancel"]').click();
        }
      }
      console.log(update?'已生成四份工具栏基准图':'四份工具栏基准图一致');
      return;
    }
    await page.goto(origin+'/');
    if(!origin.includes('127.0.0.1')) {
      assert.equal(await page.evaluate(()=>window.isSecureContext),false,'Use real insecure HTTP browser semantics');
      assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined','Exercise UUID fallback without the native method');
    }
    await page.locator('[data-action="bulk-plan"]').waitFor();
    assert.equal(await page.locator('[data-action="bulk-plan"]').count(),1,'Direct webpage maintenance has one clear entry');
    assert.equal(await page.locator('[data-action="bulk-plan"]').innerText(),'网页维护');
    assert.equal(await page.locator('[data-action="bulk-plan"]').isEnabled(),true);
    assert.ok(await page.locator('[data-action="bulk-plan"]').evaluate(el=>el.classList.contains('primary')));
    assert.equal(await page.locator('[data-action="open-workbook"],[data-action="manage-products"],#target-filter,[data-action="view-panel"]').count(),0);
    assert.equal(await page.locator('#table-view-name').isVisible(),true);
    assert.equal(await page.locator('[data-action="view-save"]').isVisible(),true);
    assert.equal(await page.locator('[data-action="rows-restore"]').isVisible(),true);
    assert.deepEqual(await page.locator('.display-toggles button').allTextContents(),
      ['显示锁单','显示要货计划','显示问界','展开版本','展开合并代际']);
    await page.screenshot({path:path.join(out,'direct-web-maintenance.png'),fullPage:true});
    const expandVersions = page.locator('[data-action="expand-versions"]');
    const ensureVersionsExpanded = async () => {
      if (await expandVersions.getAttribute('aria-expanded') !== 'true') await expandVersions.click();
    };
    const click=async action=>{
      await page.locator(`[data-action="${action}"]`).click();
      if(action==='bulk-plan') await ensureVersionsExpanded();
    };
    const openViews=async()=>assert.equal(await page.locator('#table-view-name').isVisible(),true);
    const cell=(id,month)=>page.locator(`[data-grid-id="${id}"][data-grid-month="${month}"]`);
    const waitForViewWrite=()=>page.waitForResponse(response=>
      new URL(response.url()).pathname==='/api/user-views'&&response.request().method()==='POST');
    const saveNamedView=async name=>{
      await page.locator('#table-view-name').fill(name);
      const reply=waitForViewWrite();
      await click('view-save');
      assert.ok((await reply).ok());
      await page.locator('[data-action="view-save"]:enabled').waitFor();
    };
    const resetViewFixture=async()=>{
      viewsByAccount.delete(sessionAccount);
      await page.evaluate(()=>localStorage.clear());
    };
    await openViews();
    await saveNamedView('初始视图');
    await click('bulk-plan');
    await page.locator('#grid-owner').waitFor();
    assert.equal(await page.locator('#grid-owner').inputValue(),mainAccount);
    assert.equal(await page.locator('#grid-owner').evaluate(input=>input.readOnly),true);
    assert.equal(await page.locator('#edit-dialog').evaluate(el=>el.open),false,'Batch edit must remain inside the main table');
    assert.equal(await cell('a','2026-10').inputValue(),'100');
    await cell('a','2026-10').fill('0');
    await cell('a','2026-11').fill('');
    await cell('x','2026-10').fill('-1');
    await click('grid-save');
    assert.match(await page.locator('#grid-error').innerText(),/非负整数/);
    assert.equal(await cell('x','2026-10').getAttribute('aria-invalid'),'true');
    assert.equal(savedRequests.length,0,'Invalid input must not be submitted');
    await cell('x','2026-10').fill('20');
    await page.locator('[data-grid-remove="old"]').click();
    assert.match(await page.locator('[data-grid-remove="old"]').innerText(),/撤销/);
    await page.locator('[data-grid-remove="old"]').click();
    assert.match(await page.locator('[data-grid-remove="old"]').innerText(),/删除/);
    await page.locator('[data-grid-remove="old"]').click();
    await page.locator('[data-grid-id="b"][data-grid-field="version"]').fill('Ultra改名');
    await page.locator('[data-grid-anchor="享界|S9 2026款"]').click();
    const newId=await page.locator('[data-new-row]').last().getAttribute('data-new-row');
    const newField=field=>page.locator(`[data-grid-id="${newId}"][data-grid-field="${field}"]`);
    await newField('version').fill('新增Lite');
    await cell(newId,'2026-10').fill('5');
    const requestsBefore=stateRequests;
    assert.equal(await page.locator('#refresh-btn').isVisible(),false);
    assert.equal(await page.locator('.plan-actions button').allTextContents().then(labels=>labels.join(',')),'保存修改,取消');
    assert.equal(await page.locator('.sheet-tools .display-toggles').count(),1);
    await page.evaluate(()=>pollDataStatus());
    await page.locator('[data-page="history"]').click();
    assert.equal(stateRequests,requestsBefore,'Refreshing or polling cannot replace an active draft');
    assert.equal(await cell('a','2026-10').inputValue(),'0');
    assert.equal(await cell(newId,'2026-10').inputValue(),'5');
    await page.screenshot({path:path.join(out,'editing-desktop.png'),fullPage:true});
    failure='计划已被其他人更新，请取消后刷新核对';
    await click('grid-save');
    await page.getByText(failure,{exact:false}).first().waitFor();
    assert.equal(await cell('a','2026-10').inputValue(),'0');
    assert.equal(await cell(newId,'2026-10').inputValue(),'5');
    const payload=savedRequests.at(-1);
    assert.ok(payload.changes.some(c=>c.product_id==='a'&&c.month==='2026-10'&&c.sop===0));
    assert.ok(payload.changes.some(c=>c.product_id==='a'&&c.month==='2026-11'&&c.sop===null));
    assert.ok(payload.catalog_changes.some(c=>c.id==='old'&&c.active===false&&c.plan_revisions['2026-10']===1));
    assert.ok(payload.catalog_changes.some(c=>c.id==='b'&&c.version==='Ultra改名'));
    assert.equal(payload.entries[0].plans[0].sop,5);
    failure='';loseResponse=true;
    await click('grid-save');
    await page.getByText('重试确认保存',{exact:true}).waitFor();
    const uncertainId=savedRequests.at(-1).request_id,createdCount=state.products.filter(p=>p.id.startsWith('created-')).length;
    assert.equal(await cell('a','2026-10').isDisabled(),true,'An uncertain save must not create a second mutable request');
    await click('grid-save');
    await page.locator('#grid-owner').waitFor({state:'detached'});
    assert.equal(savedRequests.at(-1).request_id,uncertainId);
    assert.equal(state.products.filter(p=>p.id.startsWith('created-')).length,createdCount);
    assert.equal(await page.locator('#grid-owner').count(),0);
    assert.equal(await page.locator('[data-version="old"]').count(),0,'Deleted row is hidden after saving');
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    await ensureVersionsExpanded();
    assert.equal(await page.locator('[data-version="old"]').count(),0,'Deleted row stays hidden after page reload');
    console.log('PASS: draft editing, validation, conflict recovery and uncertain-response retry.');

    // Cancel never writes; draft row removal affects only that new row.
    await click('bulk-plan');
    await cell('a','2026-10').fill('99');
    const addModels=page.locator('[data-action="grid-add"]');
    assert.equal(await addModels.count(),3);
    assert.deepEqual(await page.locator('tr.group-row [data-action="grid-add"]').evaluateAll(
      buttons=>buttons.map(button=>button.dataset.newModelBrand).sort()
    ),['享界','智界','问界'].sort());
    await page.locator('tr.group-row [data-action="grid-add"][data-new-model-brand="享界"]').click();
    const removable=await page.locator('[data-new-row]').last().getAttribute('data-new-row');
    assert.equal(await page.locator(`[data-grid-id="${removable}"][data-grid-field="brand"]`).inputValue(),'享界');
    await page.locator(`[data-grid-remove="${removable}"]`).click();
    assert.equal(await page.locator(`[data-new-row="${removable}"]`).count(),0);
    const callsBefore=savedRequests.length;
    await click('grid-cancel');
    assert.equal(savedRequests.length,callsBefore);
    assert.equal(state.plans.find(p=>p.product_id==='a'&&p.month==='2026-10').sop,0);

    // Hide versions/models, preserve totals, save and reload the named view.
    const hiddenBefore=Number((await page.locator('[data-action=rows-restore]').innerText()).match(/（(\d+)）/)?.[1]||0);
    await ensureVersionsExpanded();
    const totalBefore=await page.locator('tr.total-row.metric-plan-row').innerText();
    const hideVersion=page.locator('[data-hide-level="version"][data-hide-id="a"]').first();
    assert.equal(await hideVersion.innerText(),'');
    assert.match(await hideVersion.getAttribute('aria-label'),/^隐藏.+/);
    assert.equal(await hideVersion.locator('svg[aria-hidden="true"]').count(),1);
    await hideVersion.focus();
    assert.equal(await hideVersion.evaluate(button=>getComputedStyle(button).opacity),'1');
    await hideVersion.press('Enter');
    assert.equal(await page.locator('[data-version="a"]').count(),0);
    assert.equal(await page.locator('tr.total-row.metric-plan-row').innerText(),totalBefore);
    await page.locator('[data-hide-level="model"][data-hide-id="智界|R7 2026款"]').first().click();
    assert.equal(await page.locator('[data-version="x"]').count(),0);
    await openViews();
    await saveNamedView('重点车型');
    const mainViewId=personalViews().active;
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    assert.equal(await page.locator('[data-version="a"],[data-version="x"]').count(),0);
    assert.match(await page.locator('[data-action=rows-restore]').innerText(),new RegExp(`（${hiddenBefore+2}）`));
    await openViews();
    await click('rows-restore');
    assert.ok(await page.locator('[data-version="a"]').count()>0);
    assert.ok(await page.locator('[data-version="x"]').count()>0);
    assert.ok(await page.locator('[data-version="old"]').count()>0,'Restoring hidden rows reveals preserved inactive history');
    assert.equal(state.products.find(p=>p.id==='old').active,false,'Restoring visibility must not reactivate the product');
    const selectReply=waitForViewWrite();
    await page.locator('#saved-table-view').selectOption({label:'重点车型'});
    assert.ok((await selectReply).ok());
    await page.locator('[data-version="a"],[data-version="x"],[data-version="old"]').first().waitFor({state:'detached'});
    assert.equal(await page.locator('[data-version="a"],[data-version="x"],[data-version="old"]').count(),0,'Applying a named view restores its saved hidden rows');
    await click('rows-restore');

    // The same account gets its saved view in a fresh browser context.
    const secondDevice=await browser.newPage({viewport:{width:1440,height:1000}});
    try {
      await secondDevice.route(`${origin}/**`,routeApp);
      await secondDevice.goto(origin+'/');
      await secondDevice.locator('[data-action="bulk-plan"]').waitFor();
      assert.equal(await secondDevice.locator('#saved-table-view').inputValue(),mainViewId);
      assert.equal(await secondDevice.locator('#table-view-name').inputValue(),'重点车型');
      assert.equal(await secondDevice.locator('[data-version="a"],[data-version="x"],[data-version="old"]').count(),0);
      assert.ok(await secondDevice.locator('[data-version="b"]').count()>0);
    } finally {await secondDevice.close();}

    // A different login on the existing browser gets a separate list and can reuse the same name.
    sessionAccount=otherAccount;
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    assert.equal(await page.locator('#owner-btn').count(),0);
    assert.ok(!(await page.locator('.header-actions').innerText()).includes(otherAccount));
    assert.equal(await page.locator('#saved-table-view option').filter({hasText:'重点车型'}).count(),0);
    await ensureVersionsExpanded();
    assert.ok(await page.locator('[data-version="a"]').count()>0);
    assert.ok(await page.locator('[data-version="x"]').count()>0);
    await saveNamedView('重点车型');
    assert.notEqual(personalViews().active,mainViewId);
    const deleteReply=waitForViewWrite();
    await click('view-delete');
    assert.ok((await deleteReply).ok());
    assert.equal(personalViews().views.length,0);
    sessionAccount=mainAccount;
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    assert.equal(await page.locator('#saved-table-view option').filter({hasText:'重点车型'}).getAttribute('value'),mainViewId);

    // Old views only enter the current account after an explicit import and cannot replace a same-name view.
    const beforeImport=structuredClone(personalViews().views.find(view=>view.id===mainViewId));
    await page.evaluate(config=>localStorage.setItem('sop-table-views-v1',JSON.stringify({active:'old-local',views:[
      {id:'old-local',name:'旧本机视图',config},
      {id:'old-conflict',name:'重点车型',config:{...config,showLocks:false}},
    ]})),beforeImport.config);
    const writesBeforeImport=viewRequests.length;
    await page.reload();
    await page.locator('[data-action="view-import-local"]').waitFor();
    assert.equal(viewRequests.length,writesBeforeImport);
    assert.equal(await page.locator('#saved-table-view option').filter({hasText:'旧本机视图'}).count(),0);
    const importReply=waitForViewWrite();
    await click('view-import-local');
    assert.ok((await importReply).ok());
    await page.locator('[data-action="view-save"]:enabled').waitFor();
    assert.deepEqual(personalViews().views.find(view=>view.id===mainViewId),beforeImport);
    assert.ok(personalViews().views.some(view=>view.name==='旧本机视图'));
    assert.equal(viewsByAccount.get(otherAccount).views.length,0);
    await page.reload();
    await page.locator('[data-action="view-save"]:enabled').waitFor();
    assert.equal(await page.locator('[data-action="view-import-local"]').count(),0);
    assert.equal(await page.locator('#saved-table-view option').filter({hasText:'旧本机视图'}).count(),1);
    assert.deepEqual(viewRequests.filter(entry=>entry.request.action==='save').map(entry=>entry.account),
      [mainAccount,mainAccount,otherAccount]);
    assert.ok(viewRequests.every(({request})=>!['account','owner','user','principal'].some(key=>key in request)),
      'Account identity comes from the session, never from a client-supplied field');
    console.log('PASS: named views persist across browsers, isolate accounts, allow separate same-name views and explicitly import older local views.');

    // Bulk expansion can show either layer of the hierarchy.
    state=fixture('summary');
    await resetViewFixture();
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    await click('expand-generations');
    assert.ok(await page.locator('.generation-member-row.model-row').count()>0);
    assert.equal(await page.locator('[data-version="a"]').count(),0);
    await click('expand-versions');
    assert.ok(await page.locator('[data-version="a"]').count()>0);
    await click('expand-generations');
    assert.equal(await page.locator('[data-version="a"]').count(),0);
    assert.ok(await page.locator('[data-version="x"]').count()>0);
    await click('bulk-plan');
    await cell('x','2026-10').fill('25');
    await click('expand-generations');
    assert.equal(await cell('x','2026-10').inputValue(),'25');
    assert.ok(await cell('a','2026-10').count()>0);
    assert.equal(await page.locator('[data-grid-id="group"]').count(),0);
    await page.setViewportSize({width:1000,height:900});
    await page.screenshot({path:path.join(out,'editing-summary-narrow.png'),fullPage:true});
    await click('grid-cancel');

    // Model-year entry is the default; details survive zero and clear overrides.
    state=fixture();
    await resetViewFixture();
    await page.setViewportSize({width:1440,height:1000});
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    assert.equal(await page.locator('.annual-heading').count(),0);
    assert.equal(await page.locator('h1.plan-title').innerText(),'SOP计划表');
    const tableTop=(await page.locator('.plan-card').boundingBox()).y;
    const header=await page.locator('.app-header').boundingBox();
    const spaceBeforeTable=tableTop-(header.y+header.height);
    assert.ok(spaceBeforeTable<180,`The table starts ${spaceBeforeTable}px below navigation`);
    const modelCell=()=>page.locator('[data-grid-model="S9 2026款"][data-grid-month="2026-10"]');
    const beforeDetails=JSON.stringify(state.plans.filter(p=>p.product_id==='a'||p.product_id==='b'));
    for(const [input,total] of [['500',640],['0',140],['',440]]) {
      await page.locator('[data-action="bulk-plan"]').click();
      assert.equal(await page.locator('#grid-level').count(),0);
      assert.equal(await page.locator('[data-version="a"]').count(),0);
      assert.equal(await modelCell().getAttribute('placeholder'),'汇总300');
      await modelCell().fill(input);
      if(input==='500')await page.screenshot({path:path.join(out,'model-year-maintenance.png'),fullPage:true});
      await click('grid-save');
      await page.locator('#grid-owner').waitFor({state:'detached'});
      assert.equal(JSON.stringify(state.plans.filter(p=>p.product_id==='a'||p.product_id==='b')),beforeDetails);
      assert.equal(await page.evaluate(()=>sumPlan(products(),'2026-10','sop').value),total);
      await page.reload();
      await page.locator('[data-action="bulk-plan"]').waitFor();
      assert.equal(await page.evaluate(()=>sumPlan(products(),'2026-10','sop').value),total);
    }
    await page.screenshot({path:path.join(out,'compact-models.png'),fullPage:true});
    assert.equal(state.products.filter(p=>p.plan_level==='model').length,1);
    console.log('PASS: model-year default, total override, zero, clear fallback, unchanged details, compact layout and reload persistence.');

    // Numeric-cell shortcuts and model/version edits use the same main-table session.
    await ensureVersionsExpanded();
    await page.locator('[data-hide-level="version"][data-hide-id="b"]').first().click();
    await page.locator('[data-edit="a"][data-month="2026-10"]').click();
    await cell('a','2026-10').waitFor();
    assert.equal(await page.locator('#edit-dialog').evaluate(el=>el.open),false);
    assert.equal(await page.locator('#grid-level').count(),0);
    const groupId='享界|S9 2026款';
    await page.locator(`[data-grid-group="${groupId}"][data-grid-group-field="model"]`).fill('S9 更新 2026款');
    await page.locator(`[data-grid-anchor="${groupId}"]`).click();
    const inlineId=await page.locator('[data-new-row]').last().getAttribute('data-new-row');
    await page.locator(`[data-grid-id="${inlineId}"][data-grid-field="version"]`).fill('新增Plus');
    await cell(inlineId,'2026-10').fill('25');
    await page.locator(`[data-grid-remove-model="${groupId}"]`).click();
    assert.equal(await cell('a','2026-10').isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>gridPayload().entries),[]);
    await page.locator(`[data-grid-remove-model="${groupId}"]`).click();
    await page.locator(`[data-expand="${groupId}"]`).click();
    assert.equal(await page.locator('[data-version="a"]').count(),0);
    await page.locator(`[data-expand="${groupId}"]`).click();
    await click('toggle-locks');
    assert.equal(await cell(inlineId,'2026-10').inputValue(),'25');
    await click('grid-save');
    await page.locator('#grid-owner').waitFor({state:'detached'});
    assert.ok(savedRequests.at(-1).catalog_changes.some(c=>c.id==='b'&&c.model==='S9 更新 2026款'),'Renaming includes the hidden version');
    assert.equal(savedRequests.at(-1).entries[0].model,'S9 更新 2026款');
    assert.equal(state.products.find(p=>p.id==='old').model,'S9 2024款','A different year stays independent');
    await page.locator('[data-action="bulk-plan"]').click();
    await page.locator('[data-grid-remove-model="享界|S9 更新 2026款"]').click();
    await click('grid-save');
    await page.locator('#grid-owner').waitFor({state:'detached'});
    assert.equal(await page.locator('[data-expand="享界|S9 更新 2026款"]').count(),0);
    assert.ok(state.products.filter(p=>p.model==='S9 更新 2026款').every(p=>p.active===false));
    await page.locator('#restore-hidden-row').selectOption({label:'S9 更新 2026款（已停用）'});
    assert.equal(await page.locator('[data-expand="享界|S9 更新 2026款"]').count(),1);
    assert.equal(state.products.find(p=>p.id==='a').active,false,'Restore visibility does not reactivate a model');
    console.log('PASS: one inline editing path, whole-model rename/delete/undo, hidden members, year isolation and single-row restore.');

    // A new installation with no catalog or maintenance Excel can add its first row directly.
    state={...fixture(),products:[],plans:[]};
    await resetViewFixture();
    await page.reload();
    await page.locator('[data-action="bulk-plan"]').waitFor();
    assert.equal(await page.locator('[data-action="bulk-plan"]').isEnabled(),true);
    await page.locator('[data-action="bulk-plan"]').click();
    assert.equal(await page.locator('#edit-dialog').evaluate(el=>el.open),false);
    await page.locator('tr.group-row [data-action="grid-add"]').click();
    const firstId=await page.locator('[data-new-row]').getAttribute('data-new-row');
    for(const [field,value] of Object.entries({brand:'智界',model:'测试车型 2026款'})) {
      await page.locator(`[data-grid-id="${firstId}"][data-grid-field="${field}"]`).fill(value);
    }
    await cell(firstId,'2026-10').fill('15');
    await click('grid-save');
    await page.locator('#grid-owner').waitFor({state:'detached'});
    assert.equal(state.products.length,1);
    assert.equal(state.products[0].plan_level,'model');
    assert.equal(state.plans[0].sop,15);
    assert.equal(state.workbook_sync.status,'absent');
    assert.equal(apiPaths.some(p=>['/api/plan-workbook/open','/api/plan-workbook/export','/api/plan-workbook/download'].includes(p)),false,'Direct webpage maintenance must never create or open an Excel file');
    await page.setViewportSize({width:375,height:812});
    await page.screenshot({path:path.join(out,'compact-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Small screens scroll the table, not the whole page');
    state=fixture();
    const touchPage=await browser.newPage({hasTouch:true, viewport:{width:375,height:812}});
    await touchPage.route(`${origin}/**`,routeApp);
    await touchPage.goto(origin+'/');
    const hideBrand=touchPage.locator('[data-hide-level="brand"][data-hide-id="智界"]').first();
    await hideBrand.waitFor();
    assert.equal(await hideBrand.evaluate(el=>getComputedStyle(el).opacity),'1');
    const tapTarget=await hideBrand.boundingBox();
    assert.ok(tapTarget.width>=44 && tapTarget.height>=44);
    await hideBrand.tap();
    await hideBrand.waitFor({state:'detached'});
    await touchPage.close();
    assert.deepEqual(errors,[]);
    console.log(`PASS (${origin}): direct webpage maintenance without Excel, empty-catalog creation, in-table editing, zero/blank, add/delete/undo/cancel, failure recovery, idempotent retry, draft guards, persistent hidden rows/totals, named view reload and readonly summary.`);
  } catch(error) {
    if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});
    throw error;
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
