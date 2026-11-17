import assert from 'node:assert/strict';
import {createReconcilePage} from '../web/reconcile.mjs';

const listeners = {}, controls = new Map();
let markup = '', checks = [];
const host = {
  addEventListener(type, callback) { listeners[type] = callback; },
  set innerHTML(value) {
    markup = value;
    checks = [...value.matchAll(/<input type="checkbox" data-rec-select="([^"]+)"[^>]*>/g)]
      .map(match => ({dataset:{recSelect:match[1]}, checked:match[0].includes(' checked')}));
    controls.clear();
    for (const match of value.matchAll(/<button[^>]*data-rec="([^"]+)"[^>]*>(.*?)<\/button>/g)) {
      controls.set(match[1], {textContent:match[2], disabled:match[0].includes(' disabled'), focus(){}});
    }
    const count = value.match(/data-rec-selected-count[^>]*>([^<]+)/)?.[1];
    if (count) controls.set('count', {textContent:count});
  },
  get innerHTML() { return markup; },
  querySelector(selector) {
    if (selector === '[data-rec-selected-count]') return controls.get('count');
    return controls.get(selector.match(/data-rec="([^"]+)"/)?.[1]) || {focus(){}};
  },
  querySelectorAll(selector) {
    if (selector === '[data-rec-select]') return checks;
    return [...selector.matchAll(/data-rec="([^"]+)"/g)].map(match => controls.get(match[1])).filter(Boolean);
  },
};
const detail = {id:'round', name:'11月对账', start_month:'2026-11', end_month:'2026-11',
  sources:[{id:'source', type:'excel', name:'资料.xlsx', owner:'测试', created_at:'2026-11-17'}],
  targets:[{id:'model', label:'智界 R7 2027款'}], metrics:{sop_plan:'SOP计划量'},
  records:Array.from({length:101}, (_,i) => ({id:'record-'+i, source_id:'source', target_id:'model',
    metric:'sop_plan', period:'2026-11', quantity:100, status:'pending', confirmation_errors:[]})),
  result:{groups:[], issues:[{id:'issue', title:'差异', detail:'测试差异', record_ids:[]}]},
};
const page = createReconcilePage({host, api:async url => url.endsWith('/round') ? detail :
  {rounds:[{id:'round',name:'11月对账'}], snapshots:[], current_month:'2026-11', metrics:detail.metrics},
  serviceFetch:async()=>{throw new Error('Unexpected download');}, openDialog(){}, closeDialog(){},
  toast(message){throw new Error(message);}, esc:value=>String(value??''), fmt:value=>String(value??'—'),
  dateText:value=>value, isActive:()=>true, getOwner:()=>'', canWrite:()=>true, rememberOwner(){}});
const click = async (rec, id='') => listeners.click({target:{closest:()=>({dataset:{rec,id}})}});
await page.load();
assert.match(markup, /data-rec="export"/,'Export is available before entering results.');
assert.ok(markup.indexOf('异常核对') < markup.indexOf('对账结果'),'Exceptions precede final results.');
await click('view','records');
await click('select-page');
assert.equal(controls.get('count').textContent,'已选 100');
assert.equal(controls.get('select-page').textContent,'取消本页');
await click('next');
await click('select-page');
assert.equal(controls.get('count').textContent,'已选 101');
await click('select-page');
assert.equal(controls.get('count').textContent,'已选 100','Deselecting this page preserves selection on the previous page.');
await click('clear-selection');
assert.equal(controls.get('count').textContent,'已选 0');
assert.equal(controls.get('confirm-selected').disabled,true);
detail.records.forEach(record => { record.status = 'confirmed'; });
await page.load();
assert.match(markup, /data-id="issues"[^>]*>核对异常/,'After all confirmations the next action opens unresolved exceptions.');
console.log('PASS: reconciliation navigation, persistent export, reversible page selection and exception follow-up.');
