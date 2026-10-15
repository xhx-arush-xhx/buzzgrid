import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

// Expand the bundled, version-locked game server and static files locally.
// This package has zero runtime npm dependencies and never fetches source at boot.
const root=dirname(fileURLToPath(import.meta.url));
const archive=gunzipSync(readFileSync(resolve(root,'game.tar.gz')));
let offset=0,count=0;
while(offset+512<=archive.length){
 const header=archive.subarray(offset,offset+512);
 if(header.every(b=>b===0))break;
 const field=(start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/,'').trim();
 const name=field(0,100), prefix=field(345,155), type=header[156];
 const size=parseInt(field(124,12)||'0',8);
 if(!Number.isSafeInteger(size)||size<0)throw Error('Invalid bundled file size');
 const relative=prefix?`${prefix}/${name}`:name;
 const full=resolve(root,relative);
 if(!relative||full===root||!full.startsWith(root+sep))throw Error('Unsafe bundled file path');
 offset+=512;
 if(type===53||relative.endsWith('/'))mkdirSync(full,{recursive:true});
 else if(type===0||type===48){
  if(offset+size>archive.length)throw Error('Incomplete bundled file');
  mkdirSync(dirname(full),{recursive:true});
  writeFileSync(full,archive.subarray(offset,offset+size));count++;
 } else throw Error('Unsupported bundled file type');
 offset+=Math.ceil(size/512)*512;
}
if(count<15||!existsSync(resolve(root,'server/index.mjs'))||!existsSync(resolve(root,'data/players.json')))throw Error('Incomplete game bundle');
console.log(`Football Auction Royale: ${count} game files restored from the deployed build`);
await import('./server/index.mjs');