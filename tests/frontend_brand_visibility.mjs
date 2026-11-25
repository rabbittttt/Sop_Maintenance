import assert from 'node:assert/strict';
import vm from 'node:vm';

import {dashboardSource as source} from './dashboard_source.mjs';
const storage=new Map(),screen={innerHTML:''},scroll={scrollLeft:123};
let focused='';
const context=vm.createContext({
  localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
  document:{querySelector:selector=>selector==='#app'?screen:selector==='.plan-card .table-scroll'?scroll:
    /toggle-(wenjie|shangjie)/.test(selector)?{focus(){focused=selector;}}:null},
});
vm.runInContext(source.split("document.addEventListener('click'")[0],context);
const run=code=>vm.runInContext(code,context);
const get=code=>JSON.parse(JSON.stringify(run(code)));
run(`
  state={current_month:'2026-10',plan_end:'2027-12',meta:{},sales:[],model_sales:[],
    products:['问界','尚界','尊界','智界','享界'].map((brand,i)=>({id:String(i),brand,model:'M'+i,version:'Max',active:true})),
    plans:[]};
  state.plans=state.products.map((p,i)=>({product_id:p.id,month:'2026-10',sop:(i+1)*100}));
  metric='locked_orders';indexData();planning();
`);
const brandRows=()=>[...screen.innerHTML.matchAll(/<tr class="group-row[^"]*"[^>]*><th[^>]*><strong>(.*?)<\/strong>/g)].map(m=>m[1]);
const order=['智界','享界','尊界','尚界','问界'];

const visiblePlans=()=>get("sumPlan(products(),'2026-10','sop').value");
const toggle=name=>run("handleAction('toggle-"+name+"')");
assert.deepEqual(brandRows(),order.slice(0,3));
assert.deepEqual(get('products().map(p=>p.brand)'),order.slice(0,3));
assert.equal(visiblePlans(),1200);
assert.deepEqual(get('[showLocks,showDemand,...showCommitteeLevels,showWenjie,showShangjie]'),[true,false,false,false,false,false,false]);
assert.match(screen.innerHTML,/不含问界、尚界/);
assert.doesNotMatch(screen.innerHTML,/<option value="(?:问界|尚界|M0|M1)"/);

await toggle('shangjie');
assert.deepEqual(brandRows(),order.slice(0,4));
assert.equal(visiblePlans(),1400);
assert.match(screen.innerHTML,/合计（不含问界）/);
assert.equal(storage.get('sop-show-shangjie'),'true');
assert.match(focused,/toggle-shangjie/);
run("brand='尚界';model='M1';query='Max';selected='1'");
await toggle('shangjie');
assert.deepEqual(get('[brand,model,query,selected]'),['','','',null]);

await toggle('wenjie');
assert.deepEqual(brandRows(),[...order.slice(0,3),'问界']);
assert.equal(visiblePlans(),1300);
assert.match(screen.innerHTML,/合计（不含尚界）/);
assert.equal(scroll.scrollLeft,123);
assert.match(focused,/toggle-wenjie/);
assert.match(screen.innerHTML,/data-action="toggle-wenjie" aria-pressed="true"/);
assert.match(screen.innerHTML,/data-action="toggle-shangjie" aria-pressed="false"/);
await toggle('shangjie');
assert.deepEqual(brandRows(),order);
assert.equal(visiblePlans(),1500);

const reloaded=vm.createContext({localStorage:{getItem:key=>storage.get(key)??null}});
vm.runInContext(source.split("document.addEventListener('click'")[0],reloaded);
assert.equal(vm.runInContext('showWenjie && showShangjie',reloaded),true);

// A named view retains independent switches. Missing fields in older views use
// the new default, unless the saved brand filter explicitly selected that brand.
run("const allBrandsView=viewConfig();restoreViewConfig({...allBrandsView,showWenjie:false,showShangjie:true})");
assert.deepEqual(get('[viewConfig().showWenjie,viewConfig().showShangjie]'),[false,true]);
run("const legacy={...allBrandsView};delete legacy.showWenjie;delete legacy.showShangjie;restoreViewConfig(legacy)");
assert.deepEqual(get('[showWenjie,showShangjie]'),[false,false]);
run("restoreViewConfig({...legacy,brand:'尚界'});planning()");
assert.deepEqual(brandRows(),['尚界']);
assert.deepEqual(get('[showWenjie,showShangjie]'),[false,true]);
run('restoreViewConfig(legacy)');

for(const [hiddenBrand,hiddenModel,id] of [['问界','M0','0'],['尚界','M1','1']]){
  context.otherFilter={brand:hiddenBrand,model:hiddenModel,id};
  run("page='matching';brand=otherFilter.brand;model=otherFilter.model;selected=otherFilter.id");
  assert.deepEqual(get('products().map(p=>p.id)'),[id],'Other pages retain their full brand scope.');
  run("page='planning';planning()");
  assert.deepEqual(get('[brand,model,selected]'),['','',null]);
  assert.deepEqual(brandRows(),order.slice(0,3));
}
assert.equal(get('exportProducts(maintenanceExportOptions()).length'),5);
assert.equal(get('state.products.length'),5);
console.log('PASS: default metrics, independent brand visibility, totals, focus, saved preference, legacy filters, navigation and full maintenance scope.');
