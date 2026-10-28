/** GRIDLINE Studio on Cloudflare Workers + D1 + SQLite-backed Durable Objects.
 * The game state is authoritative in D1. Durable Objects only broadcast revision hints.
 * No Node, long-lived process, or paid API is required.
 */
import {templates,blankGame,sampleGame,themes} from './templates.mjs';
import {GameError,createState,applyCommand,reserveJoin,registerBuzz,submitWager,submitFinalAnswer,publicState,standings} from './engine.mjs';

const now=()=>Date.now(), uid=()=>crypto.randomUUID();
const fail=(message,status=400)=>{throw new GameError(message,status);};
const jsonParse=(s)=>JSON.parse(s);
const secureRandom=(bytes=32)=>{let a=crypto.getRandomValues(new Uint8Array(bytes));return Array.from(a,n=>n.toString(16).padStart(2,'0')).join('');};
async function sha256(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
/** Credential hashing runs in a Durable Object to fit the Workers Free CPU budget. */
async function authCrypto(env,route,payload){
 const stub=env.ROOMS.get(env.ROOMS.idFromName('__credential_auth__'));
 const r=await stub.fetch(new Request(`https://room.internal/auth/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}));
 if(!r.ok)fail('Password verification service unavailable',503);
 return r.json();
}
const dbGet=(env,sql,...params)=>env.DB.prepare(sql).bind(...params).first();
const dbAll=async(env,sql,...params)=>(await env.DB.prepare(sql).bind(...params).all()).results;
const dbRun=(env,sql,...params)=>env.DB.prepare(sql).bind(...params).run();
function response(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});}
const cookie=(request,key)=>request.headers.get('cookie')?.split(';').map(s=>s.trim().split('=')).find(([k])=>k===key)?.[1];
async function userOf(request,env){const token=cookie(request,'gridline_session');if(!token)return null;const row=await dbGet(env,'SELECT users.id,users.username,auth_sessions.csrf,auth_sessions.expires FROM auth_sessions JOIN users ON users.id=auth_sessions.user_id WHERE auth_sessions.token_hash=?',await sha256(token));return row?.expires>now()?row:null;}
async function requireUser(request,env){const u=await userOf(request,env);if(!u)fail('Please sign in to continue',401);return u;}
function requireCSRF(request,user){if(!user||request.headers.get('x-gridline-csrf')!==user.csrf)fail('Invalid request security token',403);}
function checkOrigin(request){const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)fail('Origin not allowed',403);}
async function rate(env,request,key,limit,span){const ip=request.headers.get('cf-connecting-ip')||'local';const identity=ip+':'+key,t=now();await dbRun(env,`INSERT INTO rate_windows(identity,start,hits) VALUES(?,?,1) ON CONFLICT(identity) DO UPDATE SET start=CASE WHEN excluded.start-rate_windows.start>? THEN excluded.start ELSE rate_windows.start END,hits=CASE WHEN excluded.start-rate_windows.start>? THEN 1 ELSE rate_windows.hits+1 END`,identity,t,span,span);const r=await dbGet(env,'SELECT hits FROM rate_windows WHERE identity=?',identity);if(r.hits>limit)fail('Too many requests; please try again shortly',429);}
async function readBody(request){const size=Number(request.headers.get('content-length')||0);if(size>1_100_000)fail('Request exceeds 1 MB limit',413);const txt=await request.text();if(txt.length>1_100_000)fail('Request exceeds 1 MB limit',413);try{return JSON.parse(txt||'{}');}catch{fail('Invalid JSON body');}}
const gameRow=(r)=>r&&({id:r.id,...jsonParse(r.data),createdAt:r.created_at,updatedAt:r.updated_at,archived:!!r.archived});
async function insertGame(env,owner,data){const id=uid(),t=now();await dbRun(env,'INSERT INTO games(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?)',id,owner,JSON.stringify(data),t,t);return gameRow(await dbGet(env,'SELECT * FROM games WHERE id=?',id));}
async function ownGame(request,env,gameId){const u=await requireUser(request,env);const g=await dbGet(env,'SELECT * FROM games WHERE id=? AND owner_id=?',gameId,u.id);if(!g)fail('Game not found or you do not have access',404);return gameRow(g);}
function validateGame(g){if(!g||typeof g!=='object')fail('Invalid game');if(typeof g.title!=='string'||g.title.trim().length<2||g.title.length>100)fail('Title must be 2–100 characters');if(!Array.isArray(g.rounds)||g.rounds.length<1||g.rounds.length>8)fail('Game needs 1–8 rounds');let ids=new Set();for(const r of g.rounds){if(!r.id||!Array.isArray(r.categories)||r.categories.length<1||r.categories.length>10)fail('Every round needs 1–10 categories');for(const c of r.categories){if(!c.id||typeof c.name!=='string'||!c.name.trim()||c.name.length>64||!Array.isArray(c.questions)||c.questions.length>10)fail('Invalid category');for(const q of c.questions){if(!q.id||ids.has(q.id))fail('Duplicate question IDs');ids.add(q.id);if(typeof q.prompt!=='string'||q.prompt.length>2500||typeof q.answer!=='string'||q.answer.length>1200)fail('Invalid question text');if(!Number.isSafeInteger(q.value)||q.value<=0||q.value>1_000_000)fail('Points must be positive whole numbers');if(q.imageUrl&&(!/^https:\/\//i.test(q.imageUrl)||q.imageUrl.length>2000))fail('Image URL must be HTTPS');}}}if(!Array.isArray(g.settings?.teams)||g.settings.teams.length<1||g.settings.teams.length>15)fail('Configure 1–15 teams');return g;}
function canLaunch(g){validateGame(g);const broken=g.rounds.flatMap(r=>r.categories.flatMap(c=>c.questions.filter(q=>!q.prompt.trim()||!q.answer.trim())));if(broken.length)fail(`Complete ${broken.length} missing clue/answer entries before launching`);if(g.rounds.some(r=>r.categories.every(c=>!c.questions.length)))fail('Every round needs questions');}
async function getSession(env,code){const row=await dbGet(env,'SELECT * FROM live_sessions WHERE code=?',code);return row&&({...row,state:jsonParse(row.state)});}
async function people(env,code){return dbAll(env,'SELECT id,name,team_id,joined_at,last_seen FROM participants WHERE code=? ORDER BY joined_at',code);}
async function hostAccess(request,env,s,write=false){const u=await userOf(request,env);if(u?.id&&u.id===s.owner_id){if(write)requireCSRF(request,u);return true;}const demo=request.headers.get('x-demo-host-token');if(demo&&s.demo_hash&&await sha256(demo)===s.demo_hash)return true;fail('Host permission required',403);}
async function snapshot(env,code,host=false){const s=await getSession(env,code);if(!s)fail('Session not found',404);const view=publicState({...s.state,code},await people(env,code),s.revision);if(!host)return view;const q=s.state.game.rounds[s.state.roundIndex]?.categories.flatMap(c=>c.questions).find(q=>q.id===s.state.selectedId);return {...view,question:view.question?{...view.question,answer:q?.answer||'',explanation:q?.explanation||''}:null,host:true,game:s.state.game,scoreEvents:s.state.scoreEvents,activity:s.state.activity,wagers:s.state.wagers,finalAnswers:s.state.finalAnswers};}
async function playerOf(request,env,code){const token=request.headers.get('x-player-token');if(!token||token.length>120)fail('Player identity required; join again',401);const p=await dbGet(env,'SELECT * FROM participants WHERE code=? AND token_hash=?',code,await sha256(token));if(!p)fail('Invalid or expired player identity',403);return p;}
async function makeCode(env){const letters='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';for(let i=0;i<15;i++){const code=Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>letters[n%letters.length]).join('');if(!await getSession(env,code))return code;}fail('Could not allocate a session code',503);}
async function createSession(env,game,ownerId=null,gameId=null,demoHash=null){const code=await makeCode(env),s=createState(game),t=now();await dbRun(env,'INSERT INTO live_sessions(code,owner_id,game_id,demo_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',code,ownerId,gameId,demoHash,JSON.stringify(s),t,t);return code;}
function roomStub(env,code){return env.ROOMS.get(env.ROOMS.idFromName(code));}
async function publish(env,code,revision){try{await roomStub(env,code).fetch(new Request('https://room.internal/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision})}));}catch(e){console.warn('WS notification failed; saved state is unaffected',e);}}
/** Compare-and-swap on D1 revision resolves concurrent buzzes. Other writers must retry after conflict. */
async function mutate(env,code,action,payload,fn,commandId=null,effects=[]){
 for(let attempt=0;attempt<10;attempt++){
  if(commandId&&await dbGet(env,'SELECT key FROM command_ids WHERE code=? AND key=?',code,commandId))return snapshot(env,code,true);
  const s=await getSession(env,code);if(!s)fail('Session not found',404);
  const next=fn(s.state), mutationId=uid();next.mutationId=mutationId;
  // D1 batch is transactional: the state, participant row and command receipt commit together.
  // Every side effect is conditional on this writer winning the revision compare-and-swap.
  const guard="EXISTS (SELECT 1 FROM live_sessions WHERE code=? AND revision=? AND json_extract(state,'$.mutationId')=?)";
  const guardArgs=[code,s.revision+1,mutationId];
  const statements=[env.DB.prepare('UPDATE live_sessions SET state=?,revision=revision+1,updated_at=? WHERE code=? AND revision=? AND NOT EXISTS (SELECT 1 FROM command_ids WHERE code=? AND key=?)').bind(JSON.stringify(next),now(),code,s.revision,code,commandId)];
  for(const effect of effects)statements.push(env.DB.prepare(effect.sql+guard).bind(...effect.params,...guardArgs));
  if(commandId)statements.push(env.DB.prepare('INSERT INTO command_ids(code,key,created_at) SELECT ?,?,? WHERE '+guard).bind(code,commandId,now(),...guardArgs));
  statements.push(env.DB.prepare('INSERT INTO actions(code,action,payload,timestamp) SELECT ?,?,?,? WHERE '+guard).bind(code,action,JSON.stringify(payload||{}),now(),...guardArgs));
  const [result]=await env.DB.batch(statements);
  if(result.meta.changes!==1)continue;
  await publish(env,code,s.revision+1);
  return snapshot(env,code,true);
 }
 fail('Game updated too quickly; retry your action',409);
}

async function handle(request,env){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!['GET','HEAD'].includes(method))checkOrigin(request);
 if(path==='/api/health'&&method==='GET')return response({ok:!!(await dbGet(env,'SELECT 1 AS ok'))?.ok,version:'1.0.0-cloudflare',database:true,liveSessions:(await dbGet(env,'SELECT COUNT(*) AS n FROM live_sessions')).n});
 if(path==='/api/themes'&&method==='GET')return response(themes);
 if(path==='/api/templates'&&method==='GET')return response(templates());
 if(path==='/api/auth/me'&&method==='GET'){const u=await userOf(request,env);return response(u?{id:u.id,username:u.username,csrf:u.csrf}:null);}
 if(path==='/api/auth/register'&&method==='POST'){
  await rate(env,request,'register',5,300000);const b=await readBody(request),username=String(b.username||'').trim(),pw=String(b.password||'');
  if(!/^[a-zA-Z0-9_-]{3,32}$/.test(username)||pw.length<10||pw.length>160)fail('Username 3–32 characters; password 10–160 characters');
  if(await dbGet(env,'SELECT id FROM users WHERE username=?',username))fail('Username already exists',409);
  const id=uid(),hashed=(await authCrypto(env,'hash',{password:pw})).digest;try{await dbRun(env,'INSERT INTO users(id,username,pass_hash,created_at) VALUES(?,?,?,?)',id,username,hashed,now());}catch{fail('Username already exists',409);}
  await insertGame(env,id,sampleGame());const token=secureRandom(),csrf=secureRandom();await dbRun(env,'INSERT INTO auth_sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)',await sha256(token),id,csrf,now()+604800000);
  return response({id,username,csrf},201,{'Set-Cookie':`gridline_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`});
 }
 if(path==='/api/auth/login'&&method==='POST'){
  await rate(env,request,'login',12,300000);const b=await readBody(request),u=await dbGet(env,'SELECT * FROM users WHERE username=?',String(b.username||'').trim());
  if(!u||!(await authCrypto(env,'check',{password:String(b.password||''),stored:u.pass_hash})).valid)fail('Incorrect username or password',401);
  const token=secureRandom(),csrf=secureRandom();await dbRun(env,'INSERT INTO auth_sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)',await sha256(token),u.id,csrf,now()+604800000);
  return response({id:u.id,username:u.username,csrf},200,{'Set-Cookie':`gridline_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`});
 }
 if(path==='/api/auth/logout'&&method==='POST'){
  const u=await userOf(request,env);if(u)requireCSRF(request,u);const token=cookie(request,'gridline_session');if(token)await dbRun(env,'DELETE FROM auth_sessions WHERE token_hash=?',await sha256(token));
  return response({ok:true},200,{'Set-Cookie':'gridline_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
 }
 if(path==='/api/settings'&&method==='GET'){const u=await requireUser(request,env);return response(jsonParse((await dbGet(env,'SELECT preferences FROM users WHERE id=?',u.id)).preferences));}
 if(path==='/api/settings'&&method==='PUT'){const u=await requireUser(request,env);requireCSRF(request,u);const x=await readBody(request);if(!x||typeof x!=='object'||JSON.stringify(x).length>10000)fail('Invalid settings');await dbRun(env,'UPDATE users SET preferences=? WHERE id=?',JSON.stringify(x),u.id);return response({ok:true});}
 if(path==='/api/presets'&&method==='GET'){const u=await requireUser(request,env);return response((await dbAll(env,'SELECT id,name,tokens FROM theme_presets WHERE owner_id=? ORDER BY created_at DESC',u.id)).map(p=>({...p,tokens:jsonParse(p.tokens)})));}
 if(path==='/api/presets'&&method==='POST'){const u=await requireUser(request,env);requireCSRF(request,u);const b=await readBody(request);if(!b.name||typeof b.name!=='string'||b.name.length>45||!b.tokens||typeof b.tokens!=='object'||JSON.stringify(b.tokens).length>5000)fail('Invalid preset');const preset={id:uid(),name:b.name,tokens:b.tokens};await dbRun(env,'INSERT INTO theme_presets(id,owner_id,name,tokens,created_at) VALUES(?,?,?,?,?)',preset.id,u.id,preset.name,JSON.stringify(preset.tokens),now());return response(preset,201);}
 let m=path.match(/^\/api\/presets\/([a-z0-9-]+)$/i);
 if(m&&method==='DELETE'){const u=await requireUser(request,env);requireCSRF(request,u);await dbRun(env,'DELETE FROM theme_presets WHERE id=? AND owner_id=?',m[1],u.id);return response({ok:true});}
 if(path==='/api/games'&&method==='GET'){const u=await requireUser(request,env);return response((await dbAll(env,'SELECT * FROM games WHERE owner_id=? AND archived=0 ORDER BY updated_at DESC',u.id)).map(gameRow));}
 if(path==='/api/games'&&method==='POST'){const u=await requireUser(request,env);requireCSRF(request,u);const b=await readBody(request);let data=b.templateId?templates().find(t=>t.id===b.templateId)?.game:null;if(!data)data=b.blank?blankGame():sampleGame();if(b.game)data=b.game;validateGame(data);return response(await insertGame(env,u.id,data),201);}
 m=path.match(/^\/api\/games\/([a-z0-9-]+)$/i);
 if(m){if(method==='GET')return response(await ownGame(request,env,m[1]));if(method==='PUT'){const old=await ownGame(request,env,m[1]),u=await userOf(request,env);requireCSRF(request,u);const b=validateGame(await readBody(request));await dbRun(env,'UPDATE games SET data=?,updated_at=? WHERE id=?',JSON.stringify(b),now(),old.id);return response(await ownGame(request,env,old.id));}if(method==='DELETE'){const g=await ownGame(request,env,m[1]),u=await userOf(request,env);requireCSRF(request,u);await dbRun(env,'UPDATE games SET archived=1,updated_at=? WHERE id=?',now(),g.id);return response({ok:true});}}
 m=path.match(/^\/api\/games\/([a-z0-9-]+)\/(clone|launch|export)$/i);
 if(m){const g=await ownGame(request,env,m[1]);if(m[2]==='export'&&method==='GET')return response(g,200,{'Content-Disposition':`attachment; filename="gridline-${g.id}.json"`});if(method==='POST'){const u=await userOf(request,env);requireCSRF(request,u);if(m[2]==='clone'){const {id:ignore,createdAt:ignore2,updatedAt:ignore3,archived:ignore4,...base}=g;return response(await insertGame(env,u.id,{...base,title:g.title+' — Copy'}),201);}if(m[2]==='launch'){canLaunch(g);return response({code:await createSession(env,g,u.id,g.id)},201);}}}
 if(path==='/api/demo'&&method==='POST'){await rate(env,request,'demo',6,300000);const token=secureRandom();return response({code:await createSession(env,sampleGame({name:'THE GRIDLINE SHOWCASE'}),null,null,await sha256(token)),token},201);}
 m=path.match(/^\/api\/sessions\/([A-Z0-9]{6})(?:\/(.*))?$/i);
 if(m){const code=m[1].toUpperCase(),tail=m[2]||'',s=await getSession(env,code);if(!s)fail('That session code was not found',404);
  if(!tail&&method==='GET')return response(await snapshot(env,code));
  if(tail==='host'&&method==='GET'){await hostAccess(request,env,s);return response(await snapshot(env,code,true));}
  if(tail==='events'&&method==='GET'){
   if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')fail('WebSocket upgrade required',426);
   return roomStub(env,code).fetch(request);
  }
  if(tail==='join'&&method==='POST'){
   await rate(env,request,'join',40,60000);const b=await readBody(request),name=String(b.name||'').trim(),teamId=String(b.teamId||'');
   if(!name||name.length>28)fail('Enter a name up to 28 characters');if(!s.state.teams.some(t=>t.id===teamId))fail('Select a valid team');
   const id=uid(),token=secureRandom();
   const already=await people(env,code);
   try{
    await mutate(env,code,'join-pending',{playerId:id},st=>reserveJoin(st,id,already.length),null,[{
     sql:'INSERT INTO participants(id,code,token_hash,name,team_id,joined_at,last_seen) SELECT ?,?,?,?,?,?,? WHERE ',
     params:[id,code,await sha256(token),name,teamId,now(),now()]
    }]);
   }catch(error){
    if(String(error).toLowerCase().includes('unique'))fail('Name already in use',409);
    throw error;
   }
   return response({id,token,name,teamId},201);
  }
  if(tail==='heartbeat'&&method==='POST'){const p=await playerOf(request,env,code);await dbRun(env,'UPDATE participants SET last_seen=? WHERE id=?',now(),p.id);return response({ok:true});}
  if(tail==='buzz'&&method==='POST'){await rate(env,request,'buzz',70,60000);const p=await playerOf(request,env,code);await dbRun(env,'UPDATE participants SET last_seen=? WHERE id=?',now(),p.id);const result=await mutate(env,code,'buzz',{playerId:p.id},st=>registerBuzz(st,p.id));return response({accepted:true,revision:result.revision});}
  if(tail==='wager'&&method==='POST'){const p=await playerOf(request,env,code),b=await readBody(request);if((s.state.pendingParticipants||[]).includes(p.id))fail('Awaiting host approval',403);const result=await mutate(env,code,'wager',{teamId:p.team_id},st=>submitWager(st,p.team_id,Number(b.wager)));return response({submitted:true,revision:result.revision});}
  if(tail==='answer'&&method==='POST'){const p=await playerOf(request,env,code),b=await readBody(request);if((s.state.pendingParticipants||[]).includes(p.id))fail('Awaiting host approval',403);const result=await mutate(env,code,'final-answer',{teamId:p.team_id},st=>submitFinalAnswer(st,p.team_id,b.answer));return response({submitted:true,revision:result.revision});}
  if(tail==='command'&&method==='POST'){
   await hostAccess(request,env,s,true);const b=await readBody(request);
   if(typeof b.commandId!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(b.commandId))fail('Missing unique commandId');
   if(b.type==='setMaxParticipants'){
    if(!Number.isInteger(b.maxParticipants)||b.maxParticipants<1||b.maxParticipants>60)fail('Choose between 1 and 60 participants');
    if(b.maxParticipants<(await people(env,code)).length)fail('The room already has more participants than that',409);
   }
   if(b.type==='approvePlayer'){const p=await dbGet(env,'SELECT id FROM participants WHERE code=? AND id=?',code,b.playerId);if(!p)fail('Unknown participant');}
   const effects=b.type==='rejectPlayer'?[{sql:'DELETE FROM participants WHERE code=? AND id=? AND ',params:[code,b.playerId]}]:[];
   const result=await mutate(env,code,b.type,{type:b.type,teamId:b.teamId,questionId:b.questionId,playerId:b.playerId,maxParticipants:b.maxParticipants},st=>applyCommand(st,b),b.commandId,effects);
   return response(result);
  }
  if(tail==='history'&&method==='GET'){await hostAccess(request,env,s);return response((await dbAll(env,'SELECT action,payload,timestamp FROM actions WHERE code=? ORDER BY id DESC LIMIT 300',code)).map(e=>({...e,payload:jsonParse(e.payload)})));}
  if(tail==='results.csv'&&method==='GET'){await hostAccess(request,env,s);const quote=(v)=>'"'+String(v).replaceAll('"','""')+'"';const csv='Rank,Team,Score\n'+standings(s.state).map(t=>[t.rank,t.name,t.score].map(quote).join(',')).join('\n');return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="gridline-${code}-results.csv"`}});}
 }
 fail('API route not found',404);
}
export default {async fetch(request,env,ctx){
 try{
  if(!new URL(request.url).pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  return await handle(request,env);
 }catch(err){const status=err instanceof GameError?err.status:500;if(status>=500)console.error('GRIDLINE Worker error',err);return response({error:err instanceof GameError?err.message:'Internal server error'},status);}
}};
