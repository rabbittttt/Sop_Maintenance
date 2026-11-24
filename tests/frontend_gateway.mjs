import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {dashboardSource as source} from './dashboard_source.mjs';
const prefix=source.split("document.addEventListener('click'")[0];
const plain=value=>JSON.parse(JSON.stringify(value));
function element(id='',dataset={}) {
  const attrs=new Map(),classes=new Set();
  return {id,dataset:{...dataset},type:'button',value:'',textContent:'',innerHTML:'',title:'',disabled:false,hidden:false,
    classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},
    setAttribute(name,value){attrs.set(name,String(value));},removeAttribute(name){attrs.delete(name);},
    hasAttribute(name){if(attrs.has(name))return true;return name.startsWith('data-')&&Object.hasOwn(this.dataset,name.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase()));},
    getAttribute:name=>attrs.get(name),focus(){}};
}
function fixture(base='/sop/', frameAccount=null) {
  const requests=[],controls=[element('',{action:'bulk-plan'}),element('',{action:'export-plan'}),element('',{action:'refresh-sales'}),element('',{action:'view-save'}),element('generation-filter'),element('bridge-toggle'),element('',{catalogEdit:'p1'})];
  const nodes=new Map(['access-status','grid-owner'].map(id=>['#'+id,element(id)]));
  const replies=new Map();
  const context=vm.createContext({URL,window:{sopFrameAccount:frameAccount},location:{href:'http://data.example'+base},
    document:{currentScript:{src:'http://data.example'+base+'app.js'},querySelector:selector=>nodes.get(selector)||null,
      querySelectorAll:selector=>selector.startsWith('input[id$=')?[nodes.get('#grid-owner')]:selector.startsWith('[data-action]')?controls:[]},
    localStorage:{getItem:key=>key==='sop-owner'?'client-provided-owner':null,setItem(){}},
    fetch:async(path,options)=>{requests.push({path,options});const reply=replies.get(path);if(!reply)throw new Error('Unexpected path: '+path);return reply();}});
  vm.runInContext(prefix,context);
  const run=code=>vm.runInContext(code,context);
  const respond=(path,status,body)=>replies.set(base.replace(/\/$/,'')+path,async()=>({ok:status>=200&&status<300,status,json:async()=>body}));
  return {run,respond,requests,nodes,controls};
}

// Every request, including binary imports/exports and snapshots, shares one scoped transport.
assert.equal((source.match(/\bfetch\s*\(/g)||[]).length,1);
assert.doesNotMatch(source,/(?:href|src)\s*=\s*['"]\/api\//);
let f=fixture();
assert.equal(f.run("serviceUrl('/api/history?product_id=a%2Fb&month=2026-11')"),'/sop/api/history?product_id=a%2Fb&month=2026-11');
assert.equal(f.run("serviceUrl('/api/snapshots/12/excel')"),'/sop/api/snapshots/12/excel');
assert.throws(()=>f.run("serviceUrl('https://other.example/api/state')"),/无效/);
f.respond('/api/session',200,{mode:'gateway',user:'CORP\\member',canWrite:false});
await f.run('initializeAccess()');
assert.equal(f.run('access.canWrite'),false);
assert.equal(f.run('owner'),'CORP\\member','The server identity replaces the browser owner');
assert.equal(f.requests.length,1,'Service maintenance pause does not probe write access');
assert.match(f.nodes.get('#access-status').textContent,/暂停写入/);
assert.equal(f.nodes.get('#grid-owner').readOnly,true);
assert.equal(f.nodes.get('#grid-owner').value,'CORP\\member');
assert.equal(f.controls[0].disabled,true);
assert.equal(f.controls[1].disabled,true,'POST Excel generation is disabled during a global write pause');
assert.equal(f.controls[2].disabled,true);
assert.equal(f.controls[3].disabled,true,'Saving personal views follows the service write pause');
assert.equal(f.controls[4].disabled,true);
assert.equal(f.controls[5].disabled,true);
assert.equal(f.controls[6].disabled,true);
const before=f.requests.length;
await assert.rejects(f.run("api('/api/plans',{owner:'spoofed'})"),/暂停写入/);
await assert.rejects(f.run("serviceFetch('/api/plans/import-xlsx',{method:'POST',body:'{}'})"),/暂停写入/);
assert.throws(()=>f.run('bulkPlan()'),/暂停写入/);
assert.equal(f.requests.length,before,'No mutating request leaves a paused service UI');
assert.match(f.run("button('保存','save-settings')"),/disabled/);
assert.doesNotMatch(f.run("button('恢复隐藏行','rows-restore')"),/disabled/);
f.respond('/api/state',200,{products:[]});
assert.deepEqual(plain(await f.run("api('/api/state')")),{products:[]});
assert.equal(f.requests.at(-1).path,'/sop/api/state');
f.respond('/api/user-views',200,{views:[],active:''});
assert.equal(await f.run('fetchTableViews()'),true,'Existing personal views can be read during the write pause');
assert.equal(f.requests.at(-1).path,'/sop/api/user-views');

// Configured writes still require a successful request through the IIS method gate.
f=fixture();
f.respond('/api/session',200,{mode:'gateway',user:'CORP\\planner',canWrite:true});
f.respond('/api/write-access',403,{error:'forbidden'});
await f.run('initializeAccess()');
assert.equal(f.run('access.canWrite'),false);
assert.equal(f.requests.at(-1).options.method,'POST');
assert.match(f.nodes.get('#access-status').textContent,/暂停写入/);

f=fixture();
f.respond('/api/session',200,{mode:'gateway',user:'CORP\\planner',canWrite:true});
f.respond('/api/write-access',200,{canWrite:true});
f.respond('/api/plans',200,{ok:true});
await f.run('initializeAccess()');
assert.equal(f.run('access.canWrite'),true);
assert.equal(f.controls[0].disabled,false);
assert.equal(f.nodes.get('#access-status').hidden,true,'Successful access must not add a current-user banner');
assert.equal(f.nodes.get('#access-status').textContent,'');
await f.run("api('/api/plans',{owner:'CORP\\planner',changes:[]})");
assert.equal(f.requests.at(-1).path,'/sop/api/plans');
f.respond('/api/plans',403,{error:'permission revoked'});
await assert.rejects(f.run("api('/api/plans',{changes:[]})"),/暂停写入/);
assert.equal(f.run('access.canWrite'),false,'Permission revocation locks subsequent edits');
assert.equal(f.controls[0].disabled,true);

for(const session of [{mode:'console',canWrite:true},{mode:'gateway',canWrite:true},{mode:'gateway',user:'CORP\\member',canWrite:'yes'},null]) {
  f=fixture();f.respond('/api/session',200,session);await f.run('initializeAccess()');
  assert.equal(f.run('access.canWrite'),false,'Malformed or mismatched sessions fail closed under a subpath');
}
f=fixture();f.respond('/api/session',503,{error:'unavailable'});await f.run('initializeAccess()');
assert.equal(f.run('access.canWrite'),false);
assert.match(f.nodes.get('#access-status').textContent,/无法确认/);

// The independent legacy console keeps its root API and editable owner workflow.
f=fixture('/');f.respond('/api/session',404,{error:'not found'});await f.run('initializeAccess()');
assert.equal(f.run('serviceBase'),'');assert.equal(f.run('access.canWrite'),true);
assert.equal(f.run('owner'),'client-provided-owner');
assert.equal(await f.run('fetchTableViews()'),false,'An editable owner label does not identify an account for personal views');
assert.deepEqual(f.requests.map(request=>request.path),['/api/session']);
assert.equal(f.nodes.get('#access-status').hidden,true);

f=fixture('/');f.respond('/api/session',200,{mode:'console',user:'DESKTOP\\李晓',canWrite:true});
await f.run('initializeAccess()');
assert.equal(f.run('owner'),'DESKTOP\\李晓');
assert.equal(f.nodes.get('#grid-owner').readOnly,true);
assert.equal(f.nodes.get('#grid-owner').value,'DESKTOP\\李晓');
assert.deepEqual(f.requests.map(request=>request.path),['/api/session']);

console.log('PASS: scoped API/Excel transport, gateway session checks, IIS write probe, fail-closed paused service UI, maintenance form attribution, permission revocation and legacy console.');


// Listen before the outer frame's load notification and ignore siblings / other origins.
const listeners = {};
const parent = {};
let reloads = 0;
const receiver = vm.createContext({window:{parent,addEventListener:(type,fn)=>listeners[type]=fn},
  document:{querySelector:()=>({content:'https://portal.example'})},
  location:{origin:'https://sop.example',reload:()=>reloads++}});
vm.runInContext(readFileSync(new URL('../web/frame-account.js',import.meta.url),'utf8'),receiver);
const frame = receiver.window.sopFrameAccount;
const identity = {account:'计划员023',roleCode:0,roleName:'计划员'};
const deliver = (data,source=parent,origin='https://portal.example') => listeners.message({data,source,origin});
deliver(identity,{});deliver(identity,parent,'https://other.example');deliver({...identity,roleName:''});
assert.equal(frame.current,null);
f=fixture('/sop/',frame);
f.respond('/api/session',200,{mode:'gateway',user:identity.account,canWrite:true});
f.respond('/api/write-access',200,{canWrite:true});
const login=f.run('initializeAccess()');
assert.equal(f.requests.length,0);
deliver(identity);
await login;
assert.equal(f.run('access.user'),identity.account);
assert.equal(f.run('access.canWrite'),true);
assert.equal(frame.current.roleCode,'0');
assert.ok(f.requests.every(r=>JSON.parse(decodeURIComponent(r.options.headers['Sop-Frame-Identity'])).account===identity.account));
deliver(identity);assert.equal(reloads,0);
const mismatch=fixture('/sop/',frame);
mismatch.respond('/api/session',200,{mode:'gateway',user:'other',canWrite:true});
await assert.rejects(mismatch.run('initializeAccess()'),/核对/);
assert.equal(mismatch.run('access.canWrite'),false);
deliver({...identity,account:'second'});
assert.equal(reloads,1);assert.equal(frame.current,null);
await assert.rejects(f.run("api('/api/plans',{changes:[]})"),/等待门户账号/);
console.log('PASS: iframe origin, delayed login, account binding, role code zero and switching accounts.');
