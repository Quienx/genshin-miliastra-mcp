// 打印存档第 10 段里的结构体（第 6 组）和它们的组装 / 拆分 / 修改节点定义（第 2 组，kind 1003-1005）。用法：node struct_dump.mjs <存档.gil>
import fs from 'node:fs';
import {container,fields} from '../../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
const {root}=loadGiaProto(),Def=root.lookupType('CompositeDef'),SD=root.lookupType('StructureDefWrapper.StructureDef');
const messages=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const groups=messages(container(fs.readFileSync(process.argv[2])),10).flatMap(s=>fields(s).filter(f=>f.wire===2));
console.log('groups:',groups.map(g=>g.id).join(','));
const o=x=>JSON.stringify(x);
for(const raw of groups.filter(g=>g.id===6).flatMap(g=>messages(g.data,1))){
  try{console.log('STRUCT',o(SD.toObject(SD.decode(raw),{longs:String,enums:String})));}catch(e){console.log('STRUCT raw',raw.toString('hex'));}
  console.log('STRUCT hex',raw.toString('hex'));
}
for(const raw of groups.filter(g=>g.id===2).flatMap(g=>messages(g.data,1))){
  const d=Def.toObject(Def.decode(raw),{longs:String,enums:String});
  if(['Assembly','Split','Modify'].includes(d.type?.kind))console.log('DEF',o(d));
}
