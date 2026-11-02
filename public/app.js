'use strict';
const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#${name}"/></svg>`;
let phase = 'idle', samples = [], token = '', nickname = '', timer = null, frame = null, signalAt = 0, starting = false, saving = false, savedId = '', savedRank = null, boardLoading = false;
const average = () => samples.length ? Math.round(samples.reduce((a,b)=>a+b,0)/samples.length) : null;
const clearTimer = () => { clearTimeout(timer); cancelAnimationFrame(frame); };
function showError(message = '', retry = false) {
  $('error').replaceChildren(); $('error').hidden = !message;
  if (!message) return;
  const text = document.createElement('span'); text.textContent = message; $('error').append(text);
  if (retry) { const button = document.createElement('button'); button.textContent = '저장 다시 시도'; button.disabled = saving; button.onclick = saveScore; $('error').append(button); }
}
function render() {
  $('test-card').className = `test-card phase-${phase}`;
  $('start-screen').hidden = phase !== 'idle'; $('play-area').hidden = phase === 'idle';
  $('reset').hidden = phase === 'idle'; $('reset').disabled = saving;
  $('play-area').disabled = phase === 'done';
  $('progress').textContent = phase === 'idle' ? 'READY WHEN YOU ARE' : `${Math.min(samples.length+(phase==='done'?0:1),5)} / 5 ROUND`;
  $('signal-status').textContent = phase === 'go' ? 'SIGNAL ON' : phase === 'waiting' ? 'WAIT FOR GREEN' : phase === 'done' ? 'TEST COMPLETE' : 'REFLEX LAB';
  $('average').textContent = average() ?? '—'; $('fastest').textContent = samples.length ? Math.min(...samples) : '—'; $('completed').textContent = samples.length;
  $('round-track').innerHTML = Array.from({length:5},(_,i)=>`<div class="round ${samples[i]!==undefined?'complete':phase!=='idle'&&samples.length===i?'current':''}"><span>0${i+1}</span><strong>${samples[i]!==undefined?samples[i]+' ms':'—'}</strong></div>`).join('');
  $('under-hint').textContent = phase === 'done' ? '측정 완료 · 평균값이 낮을수록 높은 순위' : '너무 일찍 눌러도 괜찮아요. 해당 회차만 다시 시작해요.';
  const panels = {
    waiting:'<div class="signal waiting-signal"><span></span></div><h3>아직, 기다려 주세요.</h3><p>초록색으로 바뀌면 바로 눌러주세요.</p><span class="action-hint">신호를 기다리는 중</span>',
    go:icon('zap')+'<h3>지금 클릭!</h3><p>CLICK · TAP · SPACE</p>',
    early:'<div class="early-symbol">!</div><h3>조금 빨랐어요.</h3><p>초록 신호가 켜진 뒤에 눌러주세요.</p><span class="action-hint">클릭해서 이번 회차 다시 도전 →</span>',
    paused:icon('clock')+'<h3>잠깐 쉬었나요?</h3><p>화면을 벗어났거나 측정 시간이 초과됐어요.</p><span class="action-hint">클릭해서 이번 회차 다시 측정 →</span>',
    result:`<div class="result-eyebrow">ROUND ${samples.length} COMPLETE</div><div class="big-result">${samples.at(-1)}<span>ms</span></div><p>기록했어요. 다음 신호를 준비하세요.</p><span class="action-hint">클릭해서 다음 회차 →</span>`,
    done:`<div class="result-eyebrow">YOUR AVERAGE REACTION TIME</div><div class="big-result">${average()}<span>ms</span></div><p>다섯 번의 반응, 하나의 기록.</p><span class="saved-status">${saving?'랭킹에 기록을 저장하는 중…':savedId?`저장 완료 · 전체 ${savedRank}위`:'아래에서 기록 저장을 다시 시도해 주세요.'}</span>`,
  };
  $('play-area').innerHTML = panels[phase] || '';
  $('play-area').setAttribute('aria-label', phase==='go'?'지금 누르세요':phase==='waiting'?'초록 신호를 기다리세요':phase==='done'?'측정 완료':'다음 측정');
}
function waitForSignal() {
  clearTimer(); phase='waiting'; render(); $('play-area').focus({preventScroll:true});
  timer=setTimeout(()=>{ frame=requestAnimationFrame(()=>{ phase='go'; render(); signalAt=performance.now(); }); },1800+Math.random()*3200);
}
async function start(event) {
  event.preventDefault(); if(starting) return;
  nickname=$('nickname').value.normalize('NFC').trim();
  if(!/^[\p{L}\p{N}_ -]{2,12}$/u.test(nickname)) { showError('닉네임은 한글·영문·숫자 등 2~12자로 입력해 주세요.'); $('nickname').focus(); return; }
  starting=true; $('start-button').disabled=true; $('start-button').textContent='연결 중…'; showError();
  try {
    const res=await fetch('/api/sessions',{method:'POST'});
    if(!res.ok) throw new Error('서버에 연결하지 못했어요. 다시 시도해 주세요.');
    token=(await res.json()).token; samples=[]; savedId=''; savedRank=null; waitForSignal();
  } catch(error) { showError(error.message); }
  finally { starting=false; $('start-button').disabled=false; $('start-button').innerHTML='테스트 시작하기 '+icon('arrow'); }
}
function react() {
  if(phase==='waiting') { clearTimer(); phase='early'; render(); }
  else if(phase==='go') {
    const ms=Math.round(performance.now()-signalAt);
    if(ms<80) { phase='early'; render(); return; }
    if(ms>5000) { phase='paused'; render(); return; }
    samples.push(ms); phase=samples.length===5?'done':'result'; render();
    if(phase==='done') void saveScore();
  } else if(['early','paused','result'].includes(phase)) waitForSignal();
}
async function saveScore() {
  if(saving||savedId) return;
  saving=true; showError(); render();
  try {
    const res=await fetch('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname,token,samples})});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'저장하지 못했어요. 다시 시도해 주세요.');
    savedId=data.id; savedRank=data.rank;
    await loadBoard();
  } catch(error) { showError(error.message,true); }
  finally { saving=false; render(); const b=$('error').querySelector('button'); if(b) b.disabled=false; }
}
async function loadBoard() {
  if(boardLoading) return;
  boardLoading=true; $('refresh-board').disabled=true;
  try {
    const res=await fetch('/api/scores',{cache:'no-store'}); if(!res.ok) throw new Error();
    const board=await res.json();
    $('total').textContent=board.total.toLocaleString(); $('best').textContent=board.best??'—';
    if(!board.scores.length) $('board-content').innerHTML='<div class="board-empty">'+icon('trophy')+'<h3>첫 기록의 주인공이 되어보세요.</h3><p>테스트를 완료하면 이곳에 기록돼요.</p><span>YOUR NAME COULD BE HERE</span></div>';
    else {
      const list=document.createElement('ol'); list.className='score-list';
      board.scores.forEach((score,i)=>{
        const li=document.createElement('li'); li.className=`${i===0?'first-place':''} ${score.id===savedId?'my-score':''}`;
        const place=document.createElement('span'); place.className='place'; place.innerHTML=i===0?icon('trophy'):String(i+1).padStart(2,'0');
        const avatar=document.createElement('div'); avatar.className='player-avatar'; avatar.textContent=score.nickname.slice(0,1);
        const name=document.createElement('span'); name.className='player-name'; name.textContent=score.nickname;
        if(score.id===savedId) { const you=document.createElement('small'); you.textContent='YOU'; name.append(you); }
        const value=document.createElement('strong'); value.textContent=score.average;
        const unit=document.createElement('small'); unit.textContent='ms'; value.append(unit);
        li.append(place,avatar,name,value); list.append(li);
      });
      $('board-content').replaceChildren(list);
    }
  } catch {
    $('total').textContent='—'; $('best').textContent='—';
    $('board-content').innerHTML='<div class="board-empty"><h3>랭킹을 불러오지 못했어요.</h3><p>연결을 확인하고 새로고침을 눌러주세요.</p></div>';
  } finally {boardLoading=false; $('refresh-board').disabled=false;}
}
$('start-form').addEventListener('submit',start);
let lastActivation=0;
$('play-area').addEventListener('pointerdown',event=>{ if(event.button!==0) return; event.preventDefault(); lastActivation=performance.now(); $('play-area').focus({preventScroll:true}); react(); });
$('play-area').addEventListener('keydown',event=>{ if(['Space','Enter'].includes(event.code)){event.preventDefault(); if(!event.repeat){lastActivation=performance.now();react();}} });
// Screen-reader activation has no pointerdown. Suppress generated clicks from handled inputs.
$('play-area').addEventListener('click',event=>{if(event.detail===0&&performance.now()-lastActivation>300) react();});
$('reset').addEventListener('click',()=>{clearTimer();phase='idle';samples=[];savedId='';savedRank=null;showError();render();$('nickname').focus({preventScroll:true});});
$('refresh-board').addEventListener('click',loadBoard);
const pause=()=>{if(['waiting','go'].includes(phase)){clearTimer();phase='paused';render();}};
window.addEventListener('blur',pause);
document.addEventListener('visibilitychange',()=>{if(document.hidden) pause();});
window.addEventListener('pagehide',clearTimer);
setInterval(()=>{if(!document.hidden&&!['waiting','go'].includes(phase)) void loadBoard();},15000);
render(); void loadBoard();
