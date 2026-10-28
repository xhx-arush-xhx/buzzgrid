import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pbkdf2Sync} from 'node:crypto';

// Only the Cloudflare base class is substituted. Exercise the actual auth handler
// and Web Crypto derivation, which the API tests' room transport mock cannot cover.
const source=readFileSync(new URL('../src/room.mjs',import.meta.url),'utf8')
 .replace('import {DurableObject} from "cloudflare:workers";','class DurableObject {}');
const {Room}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const room=new Room({},{});
const call=async(path,body)=>{
 const response=await room.fetch(new Request('https://room.example/auth/'+path,{method:'POST',body:JSON.stringify(body)}));
 return {status:response.status,data:response.status===200?await response.json():null};
};
test('real room auth uses the deployed 100000-round format and verifies independent vectors',async()=>{
 const password='a long test password',salt='0123456789abcdef0123456789abcdef';
 const known=`pbkdf2-sha256:100000:${salt}:${pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')}`;
 assert.equal((await call('check',{password,stored:known})).data.valid,true);
 assert.equal((await call('check',{password:'wrong password',stored:known})).data.valid,false);
 const first=await call('hash',{password}),second=await call('hash',{password});
 assert.match(first.data.digest,/^pbkdf2-sha256:100000:[a-f0-9]{32}:[a-f0-9]{64}$/);
 assert.notEqual(first.data.digest,second.data.digest);
 assert.equal((await call('check',{password,stored:first.data.digest})).data.valid,true);
 for(const stored of [known+':ignored',known.replace(':100000:',':1:'),known.replace(':100000:',':110000:'),'malformed']){
  assert.equal((await call('check',{password,stored})).data.valid,false);
 }
 assert.equal((await call('hash',{password:'short'})).status,400);
});
