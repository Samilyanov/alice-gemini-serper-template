import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, clean, outputText } from '../api/v2.js';

const env = {GEMINI_API_KEY:'test-not-a-real-key',SERPER_API_KEY:'test-search'};
const done = (text='Небо голубое из-за рассеяния света.',id='v1_test') => ({id,status:'completed',steps:[
  {type:'user_input',content:[{type:'text',text:'DO NOT READ THIS'}]},
  {type:'thought',content:[{type:'text',text:'PRIVATE REASONING'}]},
  {type:'model_output',content:[{type:'text',text}]}]});
const request = (command,state={},session='session-one') => ({method:'POST',body:{
  version:'1.0',request:{command},session:{session_id:session,skill_id:'skill'},state:{session:state}}});

function fixture(replies, options={}) {
  let time=1792429200000;
  const calls=[]; const logs=[];
  const fetchImpl=async (url,opts) => {
    calls.push({url,method:opts.method,body:opts.body&&JSON.parse(opts.body)});
    const next=replies.shift();
    if (!next) throw new Error('Unexpected API call');
    if (next.error) throw next.error;
    time += next.delay ?? 20;
    if (next.signalTimeout) return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
    return {ok:!next.status || next.status<400,status:next.status||200,
      json:async()=>{if(next.invalid)throw Error('invalid JSON');return next.data}};
  };
  const handler=createHandler({env,fetchImpl,now:()=>time,sleep:async ms=>{time+=ms},log:x=>logs.push(JSON.parse(x)),...options});
  return {calls,logs,handler,advance(ms){time+=ms},async ask(command,state={},session) {
    return invoke(handler,request(command,state,session));
  }};
}

async function invoke(handler,req) {
  let status=0,payload;const headers={};
  await handler(req,{setHeader(k,v){headers[k]=v},status(n){status=n;return this},json(p){payload=p;return p}});
  if(status===200 && req.method==='POST') {
    assert.equal(payload.version,'1.0');
    assert.equal(typeof payload.response.end_session,'boolean');
    assert.ok(payload.response.text.length>0&&payload.response.text.length<=1024);
    assert.ok(Buffer.byteLength(JSON.stringify(payload.session_state))<=1024);
  }
  return {status,payload,headers};
}

test('A normal answer uses Gemini background mode and never exposes thoughts or credentials',async()=>{
  const f=fixture([{data:done()}]);
  const {payload}=await f.ask('Почему небо голубое?');
  assert.match(payload.response.text,/рассеяния/);
  assert.equal(f.calls[0].body.background,true);
  assert.equal(f.calls[0].body.model,'gemini-3.5-flash-lite');
  assert.equal(f.calls[0].body.generation_config.thinking_level,'minimal');
  assert.doesNotMatch(JSON.stringify([payload,f.logs]),/test-not-a-real-key|PRIVATE|DO NOT READ/);
  assert.ok(payload.session_state.r.sig);
});

test('Slow generation survives cold starts and continuation does not create a new task',async()=>{
  const f=fixture([{data:{id:'v1_pending',status:'in_progress'},delay:3000}]);
  const first=await f.ask('Объясни квантовую физику');
  assert.match(first.payload.response.text,/Продолжай/);
  assert.ok(first.payload.session_state.p);
  const secondWorker=fixture([{data:done('Готовый ответ.','v1_pending')}]);
  secondWorker.advance(5000);
  const next=await secondWorker.ask('Продолжай',first.payload.session_state);
  assert.equal(next.payload.response.text,'Готовый ответ.');
  assert.equal(secondWorker.calls[0].method,'GET');
  assert.equal(secondWorker.calls.length,1);
  assert.ok(!next.payload.session_state.p);
});

test('Fast polling can deliver an answer in the first turn',async()=>{
  const f=fixture([{data:{id:'v1_poll',status:'in_progress'}},{data:done('Готово.','v1_poll')}]);
  const r=await f.ask('Вопрос');assert.equal(r.payload.response.text,'Готово.');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].method,'GET');
});

test('Follow-up context uses the signed previous interaction, not transcript in Alice state',async()=>{
  const f=fixture([{data:done('Запомнил: тебя зовут Антон.')},{data:done('Тебя зовут Антон.','v1_next')}]);
  const first=await f.ask('Меня зовут Антон');
  const next=await f.ask('Как меня зовут?',first.payload.session_state);
  assert.equal(f.calls[1].body.previous_interaction_id,'v1_test');
  assert.equal(next.payload.response.text,'Тебя зовут Антон.');
  assert.doesNotMatch(JSON.stringify(next.payload.session_state),/Антон/);
});

test('Forged, cross-session and expired state cannot read another interaction',async()=>{
  const f=fixture([{data:{id:'v1_secret',status:'queued'},delay:3000}]);
  const r=await f.ask('Вопрос');
  for(const bad of [
    {...r.payload.session_state,p:{...r.payload.session_state.p,id:'v1_other'}},
    {...r.payload.session_state,p:{...r.payload.session_state.p,sig:'x'.repeat(43)}},
    {...r.payload.session_state,p:{...r.payload.session_state.p,id:'../secrets'}}
  ]) {
    const probe=fixture([]);await probe.ask('Продолжай',bad);assert.equal(probe.calls.length,0);
  }
  const other=fixture([]);await other.ask('Продолжай',r.payload.session_state,'different-session');
  assert.equal(other.calls.length,0);
  f.advance(11*60*1000);await f.ask('Продолжай',r.payload.session_state);assert.equal(f.calls.length,1);
});

test('New questions replace pending work; reset clears context without new API calls',async()=>{
  const f=fixture([{data:{id:'v1_old',status:'queued'},delay:3000},{data:done('Новый ответ.','v1_new')}]);
  const old=await f.ask('Старый вопрос');const next=await f.ask('Другой вопрос',old.payload.session_state);
  assert.equal(f.calls[1].method,'POST');assert.equal(next.payload.response.text,'Новый ответ.');
  const reset=await f.ask('Новая тема',next.payload.session_state);
  assert.deepEqual(reset.payload.session_state,{v:2});assert.equal(f.calls.length,2);
});

test('Search is summarized by Gemini with sources and current date in the prompt',async()=>{
  const f=fixture([{data:{organic:[{title:'Космос',snippet:'Запущен спутник.',link:'https://example.com/article',date:'19.10.2026'}]}},
    {data:done('По данным example.com, запущен спутник.')}]);
  const r=await f.ask('Найди новости о космосе');
  assert.match(f.calls[0].url,/serper/);assert.match(f.calls[1].body.input,/Запущен спутник/);
  assert.match(f.calls[1].body.input,/example.com/);assert.match(r.payload.response.text,/запущен спутник/);
});

test('Search failure is honest and does not send a freshness question to an ungrounded model',async()=>{
  for(const reply of [{status:403,data:{}},{data:{organic:[]}},{error:Error('network')},{invalid:true}]){
    const f=fixture([reply]);const r=await f.ask('Свежие новости');
    assert.equal(f.calls.length,1);assert.ok(!r.payload.session_state.p);assert.equal(f.logs.at(-1).route,'error');
  }
});

test('Missing keys produce explicit messages without external requests',async()=>{
  const none=fixture([],{env:{}});assert.match((await none.ask('Вопрос')).payload.response.text,/ключ Gemini/);
  const search=fixture([],{env:{GEMINI_API_KEY:'test'}});
  assert.match((await search.ask('Найди новости')).payload.response.text,/SERPER_API_KEY/);
  assert.equal(search.calls.length,0);
});

test('Quota, authentication, unavailable models and provider errors are classified',async()=>{
  for(const [status,message] of [[429,/ограничил/],[403,/отклонил/],[400,/Модель/],[503,/связаться/]]){
    const f=fixture([{status,data:{}}],{env:{...env,GEMINI_BACKGROUND_MODEL:'gemini-3.1-flash-lite'}});assert.match((await f.ask('Вопрос')).payload.response.text,message);
    assert.equal(f.logs[0].status,status);
  }
});

test('Polling network failures preserve the signed task for another attempt',async()=>{
  const f=fixture([{data:{id:'v1_keep',status:'queued'}},{error:Error('network')}]);
  const r=await f.ask('Вопрос');assert.ok(r.payload.session_state.p);assert.equal(f.logs.at(-1).route,'pending_retry');
});

test('Failed or empty tasks do not leave the user in an infinite waiting loop',async()=>{
  for(const data of [{id:'v1_a',status:'failed'},{id:'v1_b',status:'completed',steps:[]},{id:'v1_c',status:'requires_action'}]){
    const f=fixture([{data}]);const r=await f.ask('Вопрос');assert.ok(!r.payload.session_state.p);
    assert.equal(f.logs.at(-1).route,'error');
  }
});

test('Maximum-length task IDs fit the one KiB state limit even while another task is pending',async()=>{
  const f=fixture([{data:done('Первый ответ','a'.repeat(320))},{data:{id:'b'.repeat(320),status:'in_progress'},delay:3000}]);
  const one=await f.ask('Один');const two=await f.ask('Два',one.payload.session_state);
  assert.ok(two.payload.session_state.p);assert.ok(two.payload.session_state.r);
});

test('Health check, unsupported methods and malformed requests do not call providers',async()=>{
  const f=fixture([]);
  const health=await invoke(f.handler,{method:'GET'});assert.equal(health.payload.version,'2.0.0');
  assert.equal((await invoke(f.handler,{method:'DELETE'})).status,405);
  assert.equal((await invoke(f.handler,{method:'POST',body:'not json'})).status,400);
  assert.equal(f.calls.length,0);
});

test('Launch, continue without a task, and exit work without providers',async()=>{
  const f=fixture([]);assert.match((await f.ask('')).payload.response.text,/Джарвис/);
  assert.match((await f.ask('Продолжай')).payload.response.text,/нет ожидающего/);
  assert.equal((await f.ask('Стоп')).payload.response.end_session,true);assert.equal(f.calls.length,0);
});

test('Real abort timer bounds a hanging upstream request',async()=>{
  const f=fixture([{signalTimeout:true}],{budgetMs:120});const start=performance.now();
  const r=await f.ask('Вопрос');assert.match(r.payload.response.text,/связаться/);
  assert.ok(performance.now()-start<600);
});

test('Output is bounded, spoken without markdown, and never includes user input or thoughts',()=>{
  const text=clean('**Текст** [источник](https://example.com) '+('длинное слово. '.repeat(200)));
  assert.ok(text.length<=1024);assert.doesNotMatch(text,/https|\*\*/);
  assert.equal(outputText(done('Только ответ.')),'Только ответ.');
});

test('Different sessions remain isolated when requests overlap',async()=>{
  const f=fixture([{data:done('Первый','v1_one')},{data:done('Второй','v1_two')}]);
  const [one,two]=await Promise.all([f.ask('Вопрос',{},'one'),f.ask('Вопрос',{},'two')]);
  assert.notEqual(one.payload.session_state.r.sig,two.payload.session_state.r.sig);
});

test('Unsupported default background model falls back once to the compatible model',async()=>{
  const f=fixture([{status:400,data:{}},{data:done('Резервная модель ответила.')}]);
  const r=await f.ask('Вопрос');assert.equal(r.payload.response.text,'Резервная модель ответила.');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.model,'gemini-3.1-flash-lite');
});
