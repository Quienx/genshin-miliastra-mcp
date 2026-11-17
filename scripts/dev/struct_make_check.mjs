// 用一份含编辑器手做结构体的存档对照工具写的结构体：按存档里的编号、引脚编号重写结构体记录和九条节点定义，逐字节比较。
// 用法：node struct_make_check.mjs <存档.gil> [结构体名]
import fs from 'node:fs';
import {container,fields} from '../../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {inspectStructs,structRecord,structDefinitions} from '../../src/scene/struct-make.mjs';
const messages=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const num=(b,id)=>{const f=fields(b).find(x=>x.id===id&&x.wire===0);return f?Number(f.value):0;};
const payload=container(fs.readFileSync(process.argv[2])),groups=messages(payload,10).flatMap(s=>fields(s).filter(f=>f.wire===2));
const s=inspectStructs(payload).find(x=>!process.argv[3]||x.name===process.argv[3]);
const raw=groups.filter(g=>g.id===6).flatMap(g=>messages(g.data,1)).find(r=>num(r,1)===s.id);
const mine=structRecord({id:s.id,name:s.name,list:s.fields,counter:num(raw,503)});
console.log('structure',s.name,s.id,mine.equals(raw)?'SAME':'DIFFERENT\n mine '+mine.toString('hex')+'\n save '+raw.toString('hex'));
const Def=loadGiaProto().root.lookupType('CompositeDef');
const theirs=groups.filter(g=>g.id===2).flatMap(g=>messages(g.data,1)).filter(r=>JSON.stringify(Def.toObject(Def.decode(r),{longs:String}).type??{}).includes('"'+s.id+'"'));
const pins=theirs.flatMap(r=>{const d=Def.decode(r);return [...(d.inflows||[]),...(d.outflows||[]),...(d.inputs||[]),...(d.outputs||[])].map(p=>p.pinIndex);});
let k=0;const first=Number(String(Def.decode(theirs[0]).id.genericId.id));
const made=structDefinitions({structId:s.id,name:s.name,list:s.fields,first},()=>pins[k++]);
console.log('definitions',theirs.length,'of 9; same bytes:',made.map((b,i)=>b.equals(theirs[i]??Buffer.alloc(0))?'yes':'NO').join(' '));
made.forEach((b,i)=>{if(!b.equals(theirs[i]??Buffer.alloc(0)))console.log(' #'+i+'\n mine',JSON.stringify(Def.toObject(Def.decode(b),{longs:String,enums:String})),'\n save',JSON.stringify(Def.toObject(Def.decode(theirs[i]),{longs:String,enums:String})));});
