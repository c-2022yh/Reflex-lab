import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi, validateScore } from '../src/api.mjs';
import { openDatabase } from '../src/local-db.mjs';
const origin='http://localhost:3000';
const request=(path,body,method=body?'POST':'GET',headers={})=>new Request(origin+path,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
async function eligibleSession(db,age=15000){const token=crypto.randomUUID();await db.prepare('INSERT INTO sessions VALUES (?,?)').bind(token,Date.now()-age).run();return token;}
const record=token=>({nickname:'Player_01',token,samples:[200,210,230,190,220],average:1});

test('computes average and fastest; rejects malformed and injected names',()=>{
 const valid=record(crypto.randomUUID()); assert.equal(validateScore(valid).average,210);assert.equal(validateScore(valid).fastest,190);
 for(const v of [null,{}, {...valid,nickname:'<script>'},{...valid,samples:[100]},{...valid,samples:[0,200,200,200,200]},{...valid,samples:[5001,200,200,200,200]},{...valid,samples:[200.5,200,200,200,200]},{...valid,samples:['200',200,200,200,200]},{...valid,token:'bad'}])assert.equal(validateScore(v),null);
 assert.equal(validateScore({...valid,nickname:'  판용  '}).nickname,'판용');
});
test('empty leaderboard and session creation',async()=>{
 const db=openDatabase(':memory:');try{
 assert.deepEqual(await(await handleApi(request('/api/scores'),db)).json(),{scores:[],total:0,best:null});
 const res=await handleApi(request('/api/sessions',null,'POST'),db);assert.equal(res.status,200);assert.ok((await res.json()).token);
 }finally{db.close();}
});
test('save, retry without duplicate, rank ordering, and altered retry',async()=>{
 const db=openDatabase(':memory:');try{
 const first=record(await eligibleSession(db));const res=await handleApi(request('/api/scores',first),db);assert.equal(res.status,200);assert.equal((await res.json()).rank,1);
 assert.equal((await handleApi(request('/api/scores',first),db)).status,200);
 assert.equal((await handleApi(request('/api/scores',{...first,nickname:'Changed'}),db)).status,409);
 const second={...record(await eligibleSession(db)),samples:[100,120,140,160,180]};await handleApi(request('/api/scores',second),db);
 const board=await(await handleApi(request('/api/scores'),db)).json();assert.equal(board.total,2);assert.equal(board.best,140);assert.equal(board.scores[0].id,second.token);assert.equal(board.scores[1].average,210);
 assert.equal((await(await handleApi(request('/api/scores',first),db)).json()).rank,2);
 }finally{db.close();}
});
test('same averages use timestamp and ID consistently',async()=>{
 const db=openDatabase(':memory:');try{
 const ids=['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
 for(const id of ids)await db.prepare('INSERT INTO scores VALUES (?,?,?,?,?,?)').bind(id,'TiedPlayer','[200,200,200,200,200]',200,200,1000).run();
 const board=await(await handleApi(request('/api/scores'),db)).json();assert.equal(board.scores[0].id,ids[1]);
 }finally{db.close();}
});
test('rejects missing, expired, and impossibly short sessions',async()=>{
 const db=openDatabase(':memory:');try{
 for(const token of [crypto.randomUUID(),await eligibleSession(db,1),await eligibleSession(db,3700000)])assert.equal((await handleApi(request('/api/scores',record(token)),db)).status,400);
 }finally{db.close();}
});
test('rejects cross-origin, bad JSON, oversized input, wrong methods and routes',async()=>{
 const db=openDatabase(':memory:');try{
 assert.equal((await handleApi(request('/api/sessions',null,'POST',{Origin:'https://elsewhere.example'}),db)).status,403);
 assert.equal((await handleApi(new Request(origin+'/api/scores',{method:'POST',body:'{bad'}),db)).status,400);
 assert.equal((await handleApi(new Request(origin+'/api/scores',{method:'POST',body:'x'.repeat(2049)}),db)).status,413);
 assert.equal((await handleApi(request('/api/sessions'),db)).status,405);
 assert.equal((await handleApi(request('/api/missing'),db)).status,404);
 assert.equal((await handleApi(request('/api/health'),null)).status,503);
 }finally{db.close();}
});
