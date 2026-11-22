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
// 结构体列表 / 字典变量（类型 26 / 27）：从存档读出初值，用存档自己的编号重写，逐字节比较。
const {structVariableBlock,structVariableOf}=await import('../../src/scene/struct-make.mjs');
const all=inspectStructs(payload),blocks=[];
const walk=b=>{let fs_;try{fs_=fields(b);}catch{return;}
  if(fs_.some(f=>f.id===2&&f.wire===2)&&fs_.some(f=>f.id===6&&f.wire===2)&&structVariableOf(b)){blocks.push(b);return;}
  for(const f of fs_)if(f.wire===2&&f.data.length)walk(f.data);};
walk(payload);
for(const b of blocks.filter((x,i)=>blocks.findIndex(y=>y.equals(x))===i)){
  const v=structVariableOf(b),st=all.find(x=>x.id===v.structId),name=messages(b,2)[0].toString('utf8'),ids=[];
  const body=messages(messages(b,4)[0],v.type==='dict'?37:36)[0];
  const read=x=>{const f35=messages(x,35)[0];ids.push(num(messages(f35,502)[0],4));
    return Object.fromEntries(messages(f35,1).map(f=>{const n=messages(f,501)[0].toString('utf8'),t=st.fields.find(y=>y.name===n).type,at=messages(f,{int:13,float:15,string:16}[t])[0];
      const raw=at&&fields(at).find(y=>y.id===1);return [n,!raw?(t==='string'?'':0):t==='string'?raw.data.toString('utf8'):t==='float'?raw.data.readFloatLE(0):Number(BigInt.asIntN(64,raw.value))];}));};
  const value=v.type==='dict'?Object.fromEntries(messages(body,501).map((k,i)=>{const raw=fields(messages(k,13)[0]).find(y=>y.id===1);return [String(raw?Number(BigInt.asIntN(64,raw.value)):0),read(messages(body,502)[i])];})):messages(body,1).map(read);
  let k=0;const mine=structVariableBlock({name,type:v.type,struct:st.name,value},all,()=>ids[k++],m=>{throw new Error(m);});
  console.log("variable",name,v.type,st.name,ids.join(","),mine.equals(b)?'SAME':'DIFFERENT\n mine '+mine.toString('hex')+'\n save '+b.toString('hex'));
}
