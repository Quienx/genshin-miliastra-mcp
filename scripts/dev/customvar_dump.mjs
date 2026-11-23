// node scripts/dev/customvar_dump.mjs <save.gil> <graphId> <name...>: the graph's nodes that name these custom variables
// (Get / Set Custom Variable), its affiliations, and the bytes around each variable block of these names in the save
// (type, value), to learn how the editor writes a custom variable of a structure type.
import fs from 'node:fs';
import {parseMessage} from 'genshin-ts/injector/binary';
import {buildNodeGraphFieldIndex} from 'genshin-ts/injector/node_graph';
import {loadGiaProto} from 'genshin-ts/injector/proto';
const [file,gid,...names]=process.argv.slice(2);
const bytes=fs.readFileSync(file),payload=bytes.subarray(20,-4),fields=[];
parseMessage(payload,0,payload.length,0,0,0,0,0,0,0,fields);
const {nodeGraphMessage}=loadGiaProto();
for(const [id,matches] of buildNodeGraphFieldIndex(payload,fields))for(const m of matches){
  if(Number(id)!==Number(gid))continue;
  const g=nodeGraphMessage.toObject(nodeGraphMessage.decode(payload.subarray(m.field.dataStart,m.field.dataEnd)),{defaults:false,longs:String,enums:String});
  console.log('AFFILIATIONS',JSON.stringify(g.affiliations));
  for(const n of g.nodes){const s=JSON.stringify(n);if(names.some(x=>s.includes('"'+x+'"'))&&[50,22].includes(Number(n.genericId?.nodeId)))console.log('NODE',s.slice(0,2000));}
}
for(const name of names){
  const key=Buffer.concat([Buffer.from([0x12,name.length]),Buffer.from(name)]);
  for(let at=payload.indexOf(key);at>=0;at=payload.indexOf(key,at+1))console.log('VAR',name,at,payload.subarray(at,at+key.length+120).toString('hex'));
}
