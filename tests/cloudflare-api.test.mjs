import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/core.mjs';
import {sampleGame} from '../src/templates.mjs';
import {pbkdf2Sync,randomBytes,timingSafeEqual} from 'node:crypto';

function createEnv(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const messages=[];let batchTail=Promise.resolve();
 return {DB:{async batch(statements){const next=batchTail.then(async()=>{sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}});batchTail=next.catch(()=>{});return next;},prepare(q){return {bind(...args){return {first:async()=>sql.prepare(q).get(...args),all:async()=>({results:sql.prepare(q).all(...args)}),run:async()=>{const res=sql.prepare(q).run(...args);return {meta:{changes:res.changes}};}}}}}},ROOMS:{idFromName:s=>s,get(id){return {fetch:async req=>{if(req.method==='POST'){
 const path=new URL(req.url).pathname;
 if(path==='/auth/hash'){const {password}=await req.json(),salt=randomBytes(16).toString('hex'),digest=pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');return Response.json({digest:`pbkdf2-sha256:100000:${salt}:${digest}`});}
 if(path==='/auth/check'){const {password,stored}=await req.json(),parts=stored.split(':'),digest=pbkdf2Sync(password,Buffer.from(parts[2],'hex'),100000,32,'sha256').toString('hex');return Response.json({valid:parts[3]===digest});}
 const {revision}=await req.json();messages.push({id,revision});return new Response('ok');}
return new Response('socket mock',{status:426});}};}},ASSETS:{fetch:async()=>new Response('asset ok')},_db:sql,_messages:messages};
}
const env=createEnv();let cookies='',csrf='',code='',gameId='',playerToken='',teamId='',playerId='';
async function query(path,method='GET',data,headers={}){
 const h=new Headers(headers);if(cookies)h.set('cookie',cookies);if(csrf&&method!=='GET'&&!h.has('x-gridline-csrf'))h.set('x-gridline-csrf',csrf);if(data!==undefined)h.set('content-type','application/json');
 const req=new Request('https://gridline.example'+path,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
 const res=await worker.fetch(req,env,{});let json=null;try{json=await res.json();}catch{json=null;}return {status:res.status,data:json,res};
}
const expect=(x,status)=>{assert.equal(x.status,status,JSON.stringify(x.data));return x.data;};
test('health, public templates and no host before login',async()=>{
 assert.equal(expect(await query('/api/health'),200).database,true);
 assert.equal(expect(await query('/api/templates'),200).length,4);
 expect(await query('/api/games'),401);
});
test('host registration stores seeded game with durable D1 schema',async()=>{
 const r=await query('/api/auth/register','POST',{username:'hosttest',password:'a long test password'});
 const u=expect(r,201);assert.equal(u.username,'hosttest');csrf=u.csrf;
 cookies=r.res.headers.get('set-cookie').split(';')[0];assert.equal(expect(await query('/api/auth/me'),200).username,'hosttest');
 const games=expect(await query('/api/games'),200);assert.equal(games.length,1);gameId=games[0].id;
});
test('game edits persist and launch returns unique code',async()=>{
 const g=expect(await query(`/api/games/${gameId}`),200);g.title='Online Friends Trivia';
 expect(await query(`/api/games/${gameId}`,'PUT',g),200);
 assert.equal(expect(await query(`/api/games/${gameId}`),200).title,'Online Friends Trivia');
 const response=await query(`/api/games/${gameId}/launch`,'POST',{});code=expect(response,201).code;
 assert.match(code,/^[A-Z0-9]{6}$/);
 expect(await query(`/api/sessions/${code}/host`),200);
});
test('public read hides answer; wrong player cannot mutate',async()=>{
 const s=expect(await query(`/api/sessions/${code}`),200);
 assert.equal(s.phase,'lobby');teamId=s.teams[0].id;
 expect(await query(`/api/sessions/${code}/command`,'POST',{type:'start',commandId:crypto.randomUUID()},{'x-gridline-csrf':'bad'}),403);
 expect(await query(`/api/sessions/${code}/buzz`,'POST',{}),401);
});
test('join lobby and broadcast update',async()=>{
 const join=expect(await query(`/api/sessions/${code}/join`,'POST',{name:'Guest One',teamId}),201);
 playerToken=join.token;playerId=join.id;
 assert.ok(env._messages.length>=1);
 const snap=expect(await query(`/api/sessions/${code}`),200);
 assert.equal(snap.players[0].name,'Guest One');
 assert.equal(snap.players[0].approved,false);
 expect(await query(`/api/sessions/${code}/join`,'POST',{name:'guest one',teamId}),409);
});
test('host starts game and selects question with server controls',async()=>{
 const doCommand=async c=>expect(await query(`/api/sessions/${code}/command`,'POST',{...c,commandId:crypto.randomUUID()}),200);
 let s=await doCommand({type:'approvePlayer',playerId});
 assert.equal(s.players[0].approved,true);
 s=await doCommand({type:'start'});assert.equal(s.phase,'board');
 s=await doCommand({type:'select',questionId:s.categories[0].questions[0].id});assert.equal(s.phase,'question');
 assert.ok(s.question.answer);const publicSnap=expect(await query(`/api/sessions/${code}`),200);
 assert.equal(publicSnap.question.answer,undefined);
 s=await doCommand({type:'openBuzz'});assert.equal(s.buzzerOpen,true);
});
test('buzzer accepts earliest and rejects late buzz, command idempotency',async()=>{
 const headers={'x-player-token':playerToken};
 const first=expect(await query(`/api/sessions/${code}/buzz`,'POST',{},headers),200);assert.equal(first.accepted,true);
 expect(await query(`/api/sessions/${code}/buzz`,'POST',{},headers),400);
 let s=expect(await query(`/api/sessions/${code}/host`),200);assert.equal(s.buzzerWinner,playerId);
 const cmdId=crypto.randomUUID();
 const before=s.revision;
 s=expect(await query(`/api/sessions/${code}/command`,'POST',{type:'judge',teamId,correct:true,commandId:cmdId}),200);
 assert.equal(s.scores[teamId],200);assert.equal(s.revision,before+1);
 const retry=expect(await query(`/api/sessions/${code}/command`,'POST',{type:'judge',teamId,correct:true,commandId:cmdId}),200);
 assert.equal(retry.scores[teamId],200);
 const publicSnap=expect(await query(`/api/sessions/${code}`),200);assert.equal(publicSnap.question.answer,undefined);const revealed=expect(await query(`/api/sessions/${code}/command`,'POST',{type:'reveal',commandId:crypto.randomUUID()}),200);assert.equal(revealed.answerRevealed,true);assert.equal(expect(await query(`/api/sessions/${code}`),200).question.answer,'Japan');
});
test('host undo and D1 action log',async()=>{
 let s=expect(await query(`/api/sessions/${code}/command`,'POST',{type:'undo',commandId:crypto.randomUUID()}),200);
 assert.equal(s.scores[teamId],0);
 const log=expect(await query(`/api/sessions/${code}/history`),200);assert.ok(log.some(e=>e.action==='undo'));
});
test('themes and preferences persist',async()=>{
 expect(await query('/api/settings','PUT',{theme:'midnight'}),200);
 assert.equal(expect(await query('/api/settings'),200).theme,'midnight');
 const preset=expect(await query('/api/presets','POST',{name:'Event Colors',tokens:{accent:'#FFFFFF'}}),201);
 assert.equal(expect(await query('/api/presets'),200)[0].id,preset.id);
});
test('session state persists through fresh reads and connects to correct room',async()=>{
 const s=expect(await query(`/api/sessions/${code}`),200);assert.equal(s.scores[teamId],0);assert.ok(env._messages.every(m=>m.id===code));
});

test('opt-in host approval blocks buzzes until host explicitly approves a joined contestant',async()=>{
 const fresh=expect(await query(`/api/games/${gameId}/launch`,'POST',{}),201).code;
 const change=async c=>expect(await query(`/api/sessions/${fresh}/command`,'POST',{...c,commandId:crypto.randomUUID()}),200);
 let s=await change({type:'setApproval',enabled:true});
 assert.equal(s.requireApproval,true);
 s=await change({type:'start'});
 const team=s.teams[0].id;
 const newcomer=expect(await query(`/api/sessions/${fresh}/join`,'POST',{name:'Pending Quizzer',teamId:team}),201);
 assert.equal(expect(await query(`/api/sessions/${fresh}`),200).players[0].approved,false);
 s=await change({type:'select',questionId:s.categories[0].questions[0].id});
 s=await change({type:'openBuzz'});
 expect(await query(`/api/sessions/${fresh}/buzz`,'POST',{}, {'x-player-token':newcomer.token}),400);
 s=await change({type:'approvePlayer',playerId:newcomer.id});
 assert.equal(s.players[0].approved,true);
 const accepted=expect(await query(`/api/sessions/${fresh}/buzz`,'POST',{}, {'x-player-token':newcomer.token}),200);
 assert.equal(accepted.accepted,true);
});


test('host sets participant limit, admits one at a time, rejects requests and fills room',async()=>{
 const room=expect(await query(`/api/games/${gameId}/launch`,'POST',{}),201).code;
 const c=async data=>query(`/api/sessions/${room}/command`,'POST',{...data,commandId:crypto.randomUUID()});
 let s=expect(await c({type:'setMaxParticipants',maxParticipants:2}),200);
 assert.equal(s.maxParticipants,2);
 expect(await c({type:'setMaxParticipants',maxParticipants:0}),400);
 const a=expect(await query(`/api/sessions/${room}/join`,'POST',{name:'Alice',teamId}),201);
 assert.equal(expect(await query(`/api/sessions/${room}`),200).joinBusy,true);
 const b=await query(`/api/sessions/${room}/join`,'POST',{name:'Bob',teamId});
 assert.equal(b.status,409);assert.match(b.data.error,/waiting for host approval/);
 expect(await c({type:'setMaxParticipants',maxParticipants:1}),200);
 expect(await c({type:'approvePlayer',playerId:a.id}),200);
 const full=await query(`/api/sessions/${room}/join`,'POST',{name:'Bob',teamId});
 assert.equal(full.status,409);assert.match(full.data.error,/room is full/);
 s=expect(await c({type:'setMaxParticipants',maxParticipants:2}),200);
 const pending=expect(await query(`/api/sessions/${room}/join`,'POST',{name:'Bob',teamId}),201);
 expect(await c({type:'rejectPlayer',playerId:pending.id}),200);
 const recovery=expect(await query(`/api/sessions/${room}/join`,'POST',{name:'Bob',teamId}),201);
 expect(await c({type:'approvePlayer',playerId:recovery.id}),200);
 s=expect(await query(`/api/sessions/${room}`),200);
 assert.equal(s.players.length,2);assert.equal(s.approvedCount,2);assert.equal(s.joinFull,true);
 expect(await c({type:'setMaxParticipants',maxParticipants:1}),409);
 assert.equal((await query(`/api/sessions/${room}/join`,'POST',{name:'Charlie',teamId})).status,409);
 assert.equal(s.players.every(p=>p.approved),true);
});

test('two concurrent joins cannot create two pending admission slots',async()=>{
 const room=expect(await query(`/api/games/${gameId}/launch`,'POST',{}),201).code;
 const x=()=>query(`/api/sessions/${room}/join`,'POST',{name:'Racer-'+crypto.randomUUID().slice(0,8),teamId});
 const [a,b]=await Promise.all([x(),x()]);
 assert.deepEqual([a.status,b.status].sort((a,b)=>a-b),[201,409]);
 const s=expect(await query(`/api/sessions/${room}`),200);
 assert.equal(s.players.length,1);assert.equal(s.joinBusy,true);
});

test('racing approval and decline never delete an approved player or corrupt the count',async()=>{
 const room=expect(await query(`/api/games/${gameId}/launch`,'POST',{}),201).code;
 const player=expect(await query(`/api/sessions/${room}/join`,'POST',{name:'Decision race',teamId}),201);
 const command=type=>query(`/api/sessions/${room}/command`,'POST',{type,playerId:player.id,commandId:crypto.randomUUID()});
 const [approved,rejected]=await Promise.all([command('approvePlayer'),command('rejectPlayer')]);
 assert.equal([approved,rejected].filter(x=>x.status===200).length,1);
 const state=expect(await query(`/api/sessions/${room}`),200);
 assert.equal(state.joinBusy,false);
 assert.equal(state.players.length,approved.status===200?1:0);
 assert.equal(state.approvedCount,state.players.length);
 const stored=JSON.parse(env._db.prepare('SELECT state FROM live_sessions WHERE code=?').get(room).state);
 assert.equal(stored.participantCount,state.players.length);
});

test('decline retries are idempotent even after the participant row is removed',async()=>{
 const room=expect(await query(`/api/games/${gameId}/launch`,'POST',{}),201).code;
 const player=expect(await query(`/api/sessions/${room}/join`,'POST',{name:'Retry decline',teamId}),201);
 const cmd={type:'rejectPlayer',playerId:player.id,commandId:crypto.randomUUID()};
 const first=expect(await query(`/api/sessions/${room}/command`,'POST',cmd),200);
 const retry=expect(await query(`/api/sessions/${room}/command`,'POST',cmd),200);
 assert.equal(retry.revision,first.revision);assert.equal(retry.participantCount,0);
});

test('failed participant insert rolls back the reservation and action log',async()=>{
 const room=expect(await query(`/api/games/${gameId}/launch`,'POST',{}),201).code;
 const before=expect(await query(`/api/sessions/${room}`),200);
 env._db.exec("CREATE TEMP TRIGGER reject_test_join BEFORE INSERT ON participants WHEN NEW.name='RollbackGuest' BEGIN SELECT RAISE(ABORT,'injected participant failure'); END;");
 try{expect(await query(`/api/sessions/${room}/join`,'POST',{name:'RollbackGuest',teamId}),500);}
 finally{env._db.exec('DROP TRIGGER reject_test_join');}
 const after=expect(await query(`/api/sessions/${room}`),200);
 assert.equal(after.revision,before.revision);assert.equal(after.joinBusy,false);assert.equal(after.participantCount,0);
 assert.equal(env._db.prepare('SELECT COUNT(*) AS n FROM actions WHERE code=?').get(room).n,0);
 expect(await query(`/api/sessions/${room}/join`,'POST',{name:'After rollback',teamId}),201);
});
