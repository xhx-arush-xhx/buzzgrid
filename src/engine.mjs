const randomUUID = () => crypto.randomUUID();
export class GameError extends Error {constructor(message,status=400){super(message);this.status=status;}}
const fail = m => {throw new GameError(m);};
const requirePhase = (s,...phases) => {if(!phases.includes(s.phase))fail(`Action unavailable in ${s.phase.replaceAll('-',' ')} mode`);};
export const questionsInRound = (s,index=s.roundIndex)=>s.game.rounds[index]?.categories.flatMap(c=>c.questions)||[];
export const currentQuestion = s => questionsInRound(s).find(q=>q.id===s.selectedId);
export const available = s => questionsInRound(s).filter(q=>!s.usedIds.includes(q.id));
export const remaining = (timer,at=Date.now())=>timer.running?Math.max(0,Math.ceil((timer.deadline-at)/1000)):Math.max(0,timer.remaining);
export function createState(game){if(!game.rounds?.length) fail('Quiz requires at least one round'); const teams=(game.settings.teams||[]).map(t=>({...t})); if(!teams.length) fail('At least one team is required');return {game:structuredClone(game),phase:'lobby',roundIndex:0,selectedId:null,usedIds:[],buzzerOpen:false,buzzerWinner:null,lockedOut:[],buzzerCycle:0,requireApproval:true,maxParticipants:8,participantCount:0,pendingParticipants:[],answerRevealed:false,judgements:[],teams,scores:Object.fromEntries(teams.map(t=>[t.id,0])),timer:{duration:game.settings.timeLimit||30,remaining:game.settings.timeLimit||30,deadline:0,running:false},scoreEvents:[],wagers:{},finalAnswers:{},finalJudged:{},winningTeams:[],startedAt:null,finishedAt:null,activity:[]};}
/** One pending admission reservation per room. All join attempts serialize using D1 revision CAS. */
export function reserveJoin(input, playerId, existingCount=0){
 const s=structuredClone(input);
 if(s.phase==='results'||(!s.game.settings.allowLateJoin&&!['lobby','board'].includes(s.phase)))throw new GameError('This session is closed',409);
 if((s.pendingParticipants||[]).length)throw new GameError('Another contestant is waiting for host approval. Please try again shortly.',409);
 const count=Math.max(Number(s.participantCount)||0,existingCount);
 if(count>=(Number(s.maxParticipants)||8))throw new GameError('This room is full. The host has reached the participant limit.',409);
 s.requireApproval=true;
 s.pendingParticipants=[playerId];
 s.participantCount=count+1;
 audit(s,'join','A contestant requested entry');
 return s;
}
export function cancelJoinReservation(input,playerId,existingCount=0){
 const s=structuredClone(input);
 if(!(s.pendingParticipants||[]).includes(playerId))return s;
 s.pendingParticipants=s.pendingParticipants.filter(id=>id!==playerId);
 s.participantCount=Math.max(existingCount,(Number(s.participantCount)||0)-1);
 return s;
}
export function standings(s){const ranked=s.teams.map(t=>({...t,score:s.scores[t.id]||0})).sort((a,b)=>b.score-a.score);let last=null,rank=0;return ranked.map((t,i)=>{if(t.score!==last)rank=i+1;last=t.score;return {...t,rank};});}
export function timerStart(t,at){if(remaining(t,at)<=0)fail('Timer has expired. Reset it first.');return {...t,deadline:at+t.remaining*1000,running:true};}
export function timerPause(t,at){return {...t,remaining:remaining(t,at),deadline:0,running:false};}
export function validateWager(score,wager){if(!Number.isInteger(wager)||wager<0)fail('Wager must be a whole number of points, zero or greater');const cap=Math.max(1000,score);if(wager>cap)fail(`Maximum wager is ${cap}`);return wager;}
const audit=(s,action,detail)=>{s.activity.unshift({id:randomUUID(),at:Date.now(),action,detail});s.activity=s.activity.slice(0,60);};
const requireTeam=(s,id)=>{if(!s.teams.some(t=>t.id===id))fail('Unknown team');};
export function applyCommand(input,cmd,at=Date.now()){
 const s=structuredClone(input);const {type}=cmd||{};
 if(!type||typeof type!=='string')fail('Missing command type');
 switch(type){
 case 'start':requirePhase(s,'lobby');if((s.pendingParticipants||[]).length)fail('Approve or reject the waiting contestant before starting');s.phase='board';s.startedAt=at;audit(s,'start','Game is live');break;
 case 'select':{
  requirePhase(s,'board');const q=questionsInRound(s).find(q=>q.id===cmd.questionId);if(!q)fail('Unknown question');if(s.usedIds.includes(q.id))fail('Question has already been played');if(!q.prompt?.trim()||!q.answer?.trim())fail('This question needs a prompt and an answer');
  s.selectedId=q.id;s.phase='question';s.buzzerOpen=s.game.settings.buzzerMode==='auto';s.buzzerWinner=null;s.lockedOut=[];s.buzzerCycle=0;s.answerRevealed=false;s.judgements=[];const seconds=Math.max(5,Math.min(3600,q.timeLimit||s.game.settings.timeLimit||30));s.timer={duration:seconds,remaining:seconds,deadline:0,running:false};audit(s,'select',`Opened ${q.value}-point question`);break;
 }
 case 'startTimer':requirePhase(s,'question','final-question');if(s.timer.running)fail('Timer already running');s.timer=timerStart(s.timer,at);audit(s,'timer','Started clock');break;
 case 'pauseTimer':requirePhase(s,'question','final-question');if(!s.timer.running)fail('Timer is not running');s.timer=timerPause(s.timer,at);audit(s,'timer','Paused clock');break;
 case 'resetTimer':requirePhase(s,'question','final-question');s.timer={...s.timer,deadline:0,running:false,remaining:s.timer.duration};audit(s,'timer','Reset clock');break;
 case 'openBuzz':requirePhase(s,'question');if(s.answerRevealed)fail('Answer has been revealed');if(s.buzzerWinner)fail('A player is locked in');s.buzzerOpen=true;s.buzzerCycle=(s.buzzerCycle||0)+1;audit(s,'buzz',s.buzzerCycle>1?'Buzzers reopened':'Buzzers opened');break;
 case 'closeBuzz':requirePhase(s,'question');s.buzzerOpen=false;audit(s,'buzz','Buzzers locked by host');break;
 case 'resetBuzz':requirePhase(s,'question');if(s.answerRevealed||s.judgements.some(j=>j.correct))fail('This question has already been settled');s.buzzerOpen=false;s.buzzerWinner=null;audit(s,'override','Host reset buzzer result');break;
 case 'setApproval':requirePhase(s,'lobby','board');if(cmd.enabled!==true)fail('Sequential joining requires host approval');s.requireApproval=true;break;
 case 'setMaxParticipants':{requirePhase(s,'lobby');const max=Number(cmd.maxParticipants);if(!Number.isInteger(max)||max<1||max>60)fail('Choose between 1 and 60 participants');if(max<(s.participantCount||0))fail('Limit cannot be smaller than the number who already joined');s.maxParticipants=max;audit(s,'join',`Participant limit set to ${max}`);break;}
 case 'rejectPlayer':{requirePhase(s,'lobby','board','question');if(typeof cmd.playerId!=='string'||!(s.pendingParticipants||[]).includes(cmd.playerId))fail('Player is not waiting for approval');s.pendingParticipants=s.pendingParticipants.filter(id=>id!==cmd.playerId);s.participantCount=Math.max(0,(s.participantCount||1)-1);audit(s,'join','Host declined a join request');break;}
 case 'approvePlayer':{requirePhase(s,'lobby','board','question');if(typeof cmd.playerId!=='string'||!(s.pendingParticipants||[]).includes(cmd.playerId))fail('Player is not pending approval');s.pendingParticipants=s.pendingParticipants.filter(id=>id!==cmd.playerId);audit(s,'join','Host approved a contestant');break;} 
 case 'reveal':requirePhase(s,'question','final-judging');s.answerRevealed=true;s.buzzerOpen=false;s.timer=timerPause(s.timer,at);audit(s,'reveal','Answer revealed');break;
 case 'judge':{
  requirePhase(s,'question');if(!s.selectedId)fail('No active question');if(s.answerRevealed||s.judgements.some(j=>j.correct))fail('Question is already settled');
  const teamId=cmd.teamId||cmd.winnerTeamId;requireTeam(s,teamId);if(s.judgements.some(j=>j.teamId===teamId))fail('Team has already answered this question');
  const q=currentQuestion(s);const correct=cmd.correct===true;const delta=correct?q.value:(s.game.settings.negativePoints?-q.value:0);
  s.scores[teamId]+=delta;const ev={id:randomUUID(),at,kind:'answer',teamId,delta,correct,questionId:q.id,undone:false};s.scoreEvents.push(ev);s.judgements.push({teamId,correct});
  if(correct){s.buzzerOpen=false;s.timer=timerPause(s.timer,at);}else{if(s.buzzerWinner)s.lockedOut.push(s.buzzerWinner);s.buzzerWinner=null;s.buzzerOpen=false;}
  audit(s,'score',`${s.teams.find(t=>t.id===teamId).name}: ${delta>=0?'+':''}${delta}`);break;
 }
 case 'complete':{
  requirePhase(s,'question');if(!s.selectedId)fail('No active question');s.usedIds.push(s.selectedId);s.selectedId=null;s.phase='board';s.buzzerOpen=false;s.buzzerWinner=null;s.answerRevealed=false;s.timer=timerPause(s.timer,at);audit(s,'complete','Question completed');break;
 }
 case 'score':{
  requireTeam(s,cmd.teamId);const delta=Number(cmd.delta);if(!Number.isSafeInteger(delta)||Math.abs(delta)>1000000||delta===0)fail('Score adjustment must be a nonzero whole number');s.scores[cmd.teamId]+=delta;s.scoreEvents.push({id:randomUUID(),at,kind:'manual',teamId:cmd.teamId,delta,undone:false});if(s.phase==='results'){const ranked=standings(s);s.winningTeams=ranked.filter(t=>t.score===ranked[0]?.score).map(t=>t.id);}audit(s,'score',`Manual score ${delta>0?'+':''}${delta}`);break;
 }
 case 'undo':{
  const e=s.scoreEvents.findLast(e=>!e.undone);if(!e)fail('No scoring event to undo');e.undone=true;s.scores[e.teamId]-=e.delta;if(e.kind==='final'&&s.phase==='final-judging')delete s.finalJudged[e.teamId];if(e.kind==='answer'&&s.phase==='question'&&e.questionId===s.selectedId){s.judgements=s.judgements.filter(j=>j.teamId!==e.teamId);s.answerRevealed=false;s.buzzerWinner=null;s.lockedOut=[];}if(s.phase==='results'){const ranked=standings(s);s.winningTeams=ranked.filter(t=>t.score===ranked[0]?.score).map(t=>t.id);}audit(s,'undo',`Reversed ${e.delta} points`);break;
 }
 case 'nextRound':{
  requirePhase(s,'board');if(available(s).length)fail('Finish all questions before advancing');if(s.roundIndex+1>=s.game.rounds.length)fail('This is the last standard round');s.roundIndex++;audit(s,'round',`Advanced to ${s.game.rounds[s.roundIndex].title}`);break;
 }
 case 'startFinal':{
  requirePhase(s,'board');if(available(s).length)fail('Finish all questions before final round');if(s.roundIndex<s.game.rounds.length-1)fail('There are more standard rounds');if(!s.game.settings.finalEnabled||!s.game.final.question?.trim()||!s.game.final.answer?.trim())fail('Final round is not enabled or configured');s.phase='final-wager';s.wagers={};s.finalAnswers={};s.finalJudged={};audit(s,'final','Final wagers open');break;
 }
 case 'lockWagers':requirePhase(s,'final-wager');s.phase='final-question';s.timer={duration:s.game.final.timeLimit||45,remaining:s.game.final.timeLimit||45,deadline:0,running:false};audit(s,'final','Wagers locked; final question displayed');break;
 case 'reviewFinal':requirePhase(s,'final-question');s.phase='final-judging';s.timer=timerPause(s.timer,at);s.answerRevealed=false;audit(s,'final','Review final answers');break;
 case 'judgeFinal':{
  requirePhase(s,'final-judging');requireTeam(s,cmd.teamId);if(s.finalJudged[cmd.teamId]!==undefined)fail('Team already judged');const wager=Number(s.wagers[cmd.teamId]||0),correct=cmd.correct===true,delta=correct?wager:-wager;
  s.scores[cmd.teamId]+=delta;s.finalJudged[cmd.teamId]=correct;s.scoreEvents.push({id:randomUUID(),at,kind:'final',teamId:cmd.teamId,delta,correct,undone:false});audit(s,'final',`Final ruling ${delta>=0?'+':''}${delta}`);break;
 }
 case 'end':{
  if(s.phase==='results')fail('Session has already ended');if(s.phase==='lobby')fail('Start the game before ending it');s.phase='results';s.finishedAt=at;s.buzzerOpen=false;s.timer=timerPause(s.timer,at);const scores=standings(s);s.winningTeams=scores.filter(t=>t.score===scores[0]?.score).map(t=>t.id);audit(s,'end','Game finished');break;
 }
 case 'renameTeam':{requirePhase(s,'lobby','board');requireTeam(s,cmd.teamId);let name=String(cmd.name||'').trim();if(name.length<2||name.length>32)fail('Team name must be 2–32 characters');s.teams.find(t=>t.id===cmd.teamId).name=name;audit(s,'team',`Renamed team ${name}`);break;}
 case 'setTheme':{if(typeof cmd.theme!=='string'||cmd.theme.length>30)fail('Invalid theme');s.game.settings.theme=cmd.theme;audit(s,'theme',`Switched theme to ${cmd.theme}`);break;}
 case 'setPreference':{const allow=['negativePoints','buzzerMode','sound','animation','timeLimit'];if(!allow.includes(cmd.name))fail('Unknown gameplay preference');if(cmd.name==='timeLimit'){if(!Number.isInteger(cmd.value)||cmd.value<5||cmd.value>3600)fail('Time limit must be 5–3600 seconds');}if(cmd.name==='buzzerMode'&&!['manual','auto'].includes(cmd.value))fail('Invalid buzzer mode');s.game.settings[cmd.name]=cmd.value;audit(s,'settings',`Changed ${cmd.name}`);break;}
 default:fail(`Unknown command: ${type}`);
 }
 return s;
}
export function registerBuzz(input,participantId){const s=structuredClone(input);requirePhase(s,'question');if(!s.buzzerOpen||s.answerRevealed||s.buzzerWinner)fail('Buzzers are not accepting responses');if((s.pendingParticipants||[]).includes(participantId))fail('Awaiting host approval');if(s.lockedOut.includes(participantId))fail('You are locked out for this question');s.buzzerWinner=participantId;s.buzzerOpen=false;audit(s,'buzz','First buzzer accepted');return s;}
export function submitWager(input,teamId,wager){const s=structuredClone(input);requirePhase(s,'final-wager');requireTeam(s,teamId);if(s.wagers[teamId]!==undefined)fail('Your team already submitted a wager');s.wagers[teamId]=validateWager(s.scores[teamId],wager);audit(s,'wager','Final wager submitted');return s;}
export function submitFinalAnswer(input,teamId,answer){const s=structuredClone(input);requirePhase(s,'final-question');requireTeam(s,teamId);if(s.finalAnswers[teamId]!==undefined)fail('Your team already submitted an answer');if(typeof answer!=='string'||!answer.trim()||answer.length>500)fail('Answer must be 1–500 characters');s.finalAnswers[teamId]=answer.trim();audit(s,'answer','Final answer submitted');return s;}
export function publicState(s,people,revision){const q=currentQuestion(s);const reveal=s.answerRevealed||s.phase==='results';return {revision,serverNow:Date.now(),phase:s.phase,code:s.code,gameTitle:s.game.title,description:s.game.description,theme:s.game.settings.theme,roundTitle:s.game.rounds[s.roundIndex]?.title,roundIndex:s.roundIndex,roundCount:s.game.rounds.length,categories:s.game.rounds[s.roundIndex]?.categories.map(c=>({id:c.id,name:c.name,questions:c.questions.map(q=>({id:q.id,value:q.value,available:!s.usedIds.includes(q.id)}))}))||[],usedCount:s.usedIds.length,totalCount:questionsInRound(s).length,question:q?{id:q.id,value:q.value,prompt:q.prompt,category:s.game.rounds[s.roundIndex]?.categories.find(c=>c.questions.some(x=>x.id===q.id))?.name||'',imageUrl:q.imageUrl||'',answer:reveal?q.answer:undefined,explanation:reveal?q.explanation:undefined}:null,teams:s.teams,scores:s.scores,standings:standings(s),buzzerOpen:s.buzzerOpen,buzzerWinner:s.buzzerWinner,buzzerState:s.phase!=='question'?'WAITING':s.answerRevealed?'CLOSED':s.buzzerWinner?'BUZZED':s.buzzerOpen?((s.buzzerCycle||0)>1?'REOPENED':'OPEN'):(s.buzzerCycle?'LOCKED':'WAITING'),requireApproval:true,maxParticipants:Math.max(1,Number(s.maxParticipants)||8,people.length),participantCount:people.length,approvedCount:people.filter(p=>!(s.pendingParticipants||[]).includes(p.id)).length,joinBusy:(s.pendingParticipants||[]).length>0,joinFull:people.length>=(Number(s.maxParticipants)||8),buzzerCycle:s.buzzerCycle||0,lockedOut:s.lockedOut,answerRevealed:s.answerRevealed,correctJudged:s.judgements.some(j=>j.correct),timer:s.timer,players:people.map(p=>({id:p.id,name:p.name,teamId:p.team_id,online:Date.now()-p.last_seen<60000,approved:!(s.pendingParticipants||[]).includes(p.id)})),lastEvent:s.activity[0]||null,finalCategory:s.phase.startsWith('final')||s.phase==='results'?s.game.final.category:null,finalQuestion:['final-question','final-judging'].includes(s.phase)?s.game.final.question:null,finalAnswer:reveal&&s.phase==='final-judging'?s.game.final.answer:undefined,finalJudged:s.finalJudged,submittedWagers:Object.keys(s.wagers),submittedFinalAnswers:Object.keys(s.finalAnswers),winners:s.winningTeams,startedAt:s.startedAt,finishedAt:s.finishedAt};}
