import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('completed result shows the five-sample range while average, fastest and saved rank remain intact', async () => {
  const nodes = new Map();
  const element = () => ({ textContent: '', innerHTML: '', hidden: false, value: '',
    addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {}, querySelector() { return null; } });
  const document = { hidden: false, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, addEventListener() {}, createElement: element };
  const context = vm.createContext({ document, window: { addEventListener() {} }, setInterval() {}, setTimeout() {}, clearTimeout() {}, cancelAnimationFrame() {},
    fetch: async () => ({ ok: true, json: async () => ({ total: 0, best: null, scores: [] }) }) });
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("samples=[200,210,230,190,220];phase='done';savedId='saved';savedRank=2;render()", context);
  assert.equal(nodes.get('average').textContent, 210);
  assert.equal(nodes.get('fastest').textContent, 190);
  assert.equal(nodes.get('completed').textContent, 5);
  assert.match(nodes.get('play-area').innerHTML, /반응시간 편차 <strong>40 ms/);
  assert.match(nodes.get('play-area').innerHTML, /작을수록 이번 도전의 반응이 일정/);
  assert.match(nodes.get('play-area').innerHTML, /저장 완료 · 전체 2위/);
  vm.runInContext('samples=[200,200,200,200,200];render()', context);
  assert.match(nodes.get('play-area').innerHTML, /<strong>0 ms/);
  vm.runInContext("samples=[];phase='idle';render()", context);
  assert.doesNotMatch(nodes.get('play-area').innerHTML, /반응시간 편차/);
});
