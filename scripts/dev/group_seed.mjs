// Usage: node scripts/dev/group_seed.mjs SAVE.gil [SEED_OUT.json]
// Reads the prefab groups (asset 10008001) of a save, rebuilds each from its own members with groupEntry and compares
// byte for byte; with SEED_OUT also writes the constant parts of the first one (editor defaults, no level content).
import fs from 'node:fs';
import {container,fields,one} from '../../src/scene/wire.mjs';
import {groupEntry,GROUP_ASSET} from '../../src/scene-save.mjs';
const [file,seedOut]=process.argv.slice(2),root=container(fs.readFileSync(file));
const num=(b,id)=>{const x=fields(b).find(x=>x.id===id&&x.wire===0);return x?Number(x.value):null;};
const f32=(b,id)=>{const x=fields(b).find(x=>x.id===id&&x.wire===5);return x?x.data.readFloatLE(0):0;};
let ok=0,bad=0;
for(const f of fields(one(root,4))){
  if(f.id!==1||num(f.data,2)!==GROUP_ASSET)continue;
  const recs=fields(f.data).filter(p=>p.id===6&&p.wire===2);
  const name=one(one(recs.find(p=>num(p.data,1)===1).data,11),1).toString();
  const members=fields(one(recs.find(p=>num(p.data,1)===61).data,65)).filter(m=>m.id===1).map(m=>({prefabId:num(m.data,1),position:[1,2,3].map(i=>f32(one(m.data,2),i)),rotation:[1,2,3].map(i=>f32(one(m.data,3),i))}));
  if(seedOut&&ok+bad===0){
    const hex=a=>Buffer.concat(a.map(p=>p.raw)).toString('hex'),by=k=>recs.filter(p=>k.includes(num(p.data,1)));
    fs.writeFileSync(seedOut,JSON.stringify({note:'constant parts of a prefab group entry: records of kind 13,14,38,40,111 / 62 / the blocks 7, 8, 9, 10',head:hex(by([13,14,38,40,111])),tail62:hex(by([62])),rest:hex(fields(f.data).filter(p=>p.id>=7))})+'\n');
  }
  // The entry is the bytes of the field after its key and length.
  const built=groupEntry({prefabId:num(f.data,1),name,members});
  if(built.equals(f.data))ok++;else{bad++;console.log('DIFF',name);}
}
console.log({groups:ok+bad,identical:ok,different:bad});
process.exit(bad||!ok?1:0);
