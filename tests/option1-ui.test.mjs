import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createState,applyCommand,publicState,registerBuzz} from '../src/engine.mjs';
import {sampleGame} from '../src/templates.mjs';
const path=new URL('../web/app.js',import.meta.url);
const source=readFileSync(path,'utf8').split('(async function boot(){')[0];
const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const ctx={localStorage:storage,location:{pathname:'/session/ABCDEF/control',origin:'https://example.workers.dev',host:'example.workers.dev'},document:{addEventListener:()=>{},querySelector:()=>null,querySelectorAll:()=>[]},window:{addEventListener:()=>{}},console,setInterval:()=>0,clearInterval:()=>{}};
const ui=vm.runInNewContext(source+'\n({A,selectedQuestion,buzzerArena,hostControls,hostSession,stage,playerView,lobby})',ctx);
function state(){const game=sampleGame();let s=createState(game);s=applyCommand(s,{type:'start'});s=applyCommand(s,{type:'select',questionId:game.rounds[0].categories[0].questions[0].id});return s;}
test('host and audience render the live question with central contestant buzzer, not the answer',()=>{
 const s=state(),p=publicState(s,[{id:'p1',name:'Quizzer 1',team_id:'t1',last_seen:Date.now()}],1);
 assert.match(ui.selectedQuestion(p),/question-clue/);assert.doesNotMatch(ui.selectedQuestion(p),/OFFICIAL ANSWER/);
 assert.match(ui.buzzerArena(p),/central-buzzer/);assert.match(ui.buzzerArena(p),/Quizzer 1/);
 assert.match(ui.hostControls(p),/REVEAL ANSWER/);
 ui.A.session={...p,question:{...p.question,answer:'Private answer'},game:s.game,activity:[]};
 const host=ui.hostSession();assert.match(host,/PRIVATE ANSWER KEY/);assert.match(host,/<details/);
});
test('host-initiated answer reveal is shown on audience and player views',()=>{
 let s=state();s=applyCommand(s,{type:'judge',teamId:'t1',correct:true});
 let p=publicState(s,[],2);assert.equal(p.question.answer,undefined);assert.doesNotMatch(ui.selectedQuestion(p,true),/OFFICIAL ANSWER/);
 s=applyCommand(s,{type:'reveal'});p=publicState(s,[],3);
 assert.match(ui.selectedQuestion(p,true),/OFFICIAL ANSWER/);assert.ok(p.question.answer);
});
test('approval indicator and waiting interface render without any account tokens in HTML',()=>{
 const s=createState(sampleGame());s.pendingParticipants=['p1'];const p=publicState(s,[{id:'p1',name:'New contestant',team_id:'t1',last_seen:Date.now()}],1);
 assert.match(ui.lobby(p,true),/PARTICIPANT LIMIT/);assert.match(ui.lobby(p,true),/ADMIT/);assert.match(ui.lobby(p,true),/AWAITING APPROVAL/);
});
