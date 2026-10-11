/** One hibernating Durable Object per live game; never stores answer keys in socket messages. */
import {DurableObject} from "cloudflare:workers";
const randomHex = (count) => Array.from(crypto.getRandomValues(new Uint8Array(count)),n=>n.toString(16).padStart(2,'0')).join('');
const decodeHex = s => Uint8Array.from(s.match(/.{2}/g).map(x=>parseInt(x,16)));
async function derive(password,salt){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
 const b=await crypto.subtle.deriveBits({name:'PBKDF2',salt:decodeHex(salt),iterations:110000,hash:'SHA-256'},key,256);
 return Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
}
const timeEqual=(a,b)=>{if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
export class Room extends DurableObject {
 constructor(ctx, env) { super(ctx, env); }
 async fetch(request) {
  const path=new URL(request.url).pathname;
  if(request.method==='POST' && path==='/auth/hash'){
   const {password}=await request.json();
   if(typeof password!=='string'||password.length<10||password.length>160)return new Response('Bad input',{status:400});
   const salt=randomHex(16);
   return new Response(JSON.stringify({digest:`pbkdf2-sha256:110000:${salt}:${await derive(password,salt)}`}),{headers:{'Content-Type':'application/json'}});
  }
  if(request.method==='POST' && path==='/auth/check'){
   const {password,stored}=await request.json();
   let valid=false;
   if(typeof password==='string'&&password.length<=160&&typeof stored==='string'){
    const [algo,rounds,salt,expected]=stored.split(':');
    if(algo==='pbkdf2-sha256'&&rounds==='110000'&&/^[0-9a-f]{32}$/.test(salt||'')&&/^[0-9a-f]{64}$/.test(expected||''))valid=timeEqual(await derive(password,salt),expected);
   }
   return new Response(JSON.stringify({valid}),{headers:{'Content-Type':'application/json'}});
  }
  if(request.method==='POST' && new URL(request.url).pathname==='/notify') {
   let revision=0;try{revision=(await request.json()).revision;}catch{}
   this.notify(revision);return new Response('ok');
  }
  if(request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required',{status:426});
  const pair=new WebSocketPair();
  const [client,server]=Object.values(pair);
  this.ctx.acceptWebSocket(server);
  server.send(JSON.stringify({kind:'connected'}));
  return new Response(null,{status:101,webSocket:client});
 }
 async notify(revision) {
  const message=JSON.stringify({kind:'update',revision});
  for(const ws of this.ctx.getWebSockets()) {try{ws.send(message);}catch{try{ws.close(1011,'Reconnecting');}catch{}}}
 }
 async webSocketMessage(ws,message) {
  // Incoming clients are not allowed to issue state-changing commands over WS.
  if(message==='ping')ws.send('pong');
 }
 async webSocketClose(ws,code,reason,clean) {try{ws.close(code,reason);}catch{}}
}
