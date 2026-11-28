import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/operation-log.js', import.meta.url), 'utf8');
const elements = new Map();
const requests = [];
function node(id) {
  const element = {isConnected:true, dataset:{}, value:'', updates:0,
    get innerHTML() { return this.markup || ''; },
    set innerHTML(html) { this.markup=html; this.updates++; }, setAttribute(key, value) { this[key]=value; }};
  elements.set(id, element);
  return element;
}
const app = node('#app');
Object.defineProperty(app, 'innerHTML', {set() {
  node('#operation-log-filter');
  node('#operation-log-results');
}});
const context = vm.createContext({
  page:'operation-log', document:{hidden:false}, pageHeading:()=>'',
  opt:(id, label)=>`<option value="${id}">${label}</option>`,
  URLSearchParams, dateText:v=>v, esc:v=>String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;'),
  $:selector=>elements.get(selector) ?? (selector === '#operation-log-filter' ? null : node(selector)),
  api:path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}))
});
vm.runInContext(source, context);
const fixture = {recorded_at:'2026-10-22 20:00:00',owner:'张三',action:'修改计划',subject:'智界 R7',month:'2026-12',detail:'SOP计划量 100 → 0',reason:'<test>'};
const results = ()=>elements.get('#operation-log-results').innerHTML;
const open = vm.runInContext('operationLogPage', context);
let pending = open();
assert.equal(requests.at(-1).path, '/api/operations');
requests.at(-1).resolve({items:[fixture],next_cursor:'log+/1='});
await pending;
for (const value of ['张三','智界 R7','2026-12','100 → 0','&lt;test>','第 1 页','上一页','下一页']) assert.ok(results().includes(value),value);
assert.equal(elements.get('#operation-log-results')['aria-busy'],'false');
const poll = vm.runInContext('pollOperationLog', context);
const body = elements.get('#operation-log-results');
const initialWrites = body.updates;
let checks = requests.length;
context.document.hidden=true;
await poll();
assert.equal(requests.length,checks);
context.document.hidden=false;
pending=poll();
await poll();
assert.equal(requests.length,checks+1);
requests.at(-1).resolve({items:[fixture],next_cursor:'log+/1='});
await pending;
assert.equal(body.updates,initialWrites,'Unchanged polling keeps the table DOM intact');
pending=poll();
requests.at(-1).reject(new Error('暂时离线'));
await pending;
assert.equal(body.updates,initialWrites);
pending=poll();
requests.at(-1).resolve({items:[{...fixture,owner:'李四'}],next_cursor:'log+/1='});
await pending;
assert.match(results(),/李四/);

pending = elements.get('#operation-log-next').onclick();
assert.equal(requests.at(-1).path,'/api/operations?cursor=log%2B%2F1%3D');
requests.at(-1).resolve({items:[{...fixture,subject:'享界 S9'}],next_cursor:null});
await pending;
assert.match(results(), /第 2 页/);
checks=requests.length;
await poll();
assert.equal(requests.length,checks);
assert.match(results(), /id="operation-log-next" disabled/);
pending = elements.get('#operation-log-prev').onclick();
assert.equal(requests.at(-1).path, '/api/operations');
const previous = requests.at(-1);
const filter = elements.get('#operation-log-filter');
filter.value = 'reconcile';
const changed = filter.onchange();
assert.equal(requests.at(-1).path, '/api/operations?entity=reconcile');
requests.at(-1).resolve({items:[],next_cursor:null});
await changed;
previous.resolve({items:[fixture],next_cursor:null});
await pending;
assert.match(results(), /暂无操作记录/);
assert.doesNotMatch(results(), /张三|上一页/);

pending = open();
requests.at(-1).reject(new Error('请求失败'));
await pending;
assert.match(results(), /请求失败/);
pending = elements.get('#operation-log-retry').onclick();
assert.equal(requests.at(-1).path, '/api/operations?entity=reconcile');
context.page = 'history';
elements.get('#operation-log-results').innerHTML = '其他页面';
requests.at(-1).resolve({items:[fixture],next_cursor:null});
await pending;
assert.equal(results(),'其他页面');
console.log('PASS: operation log shows owner, changes and reasons; filters, cursor pagination, stale responses, retry and navigation.');
