// node scripts/dev/graphvar_dump.mjs <save.gil> <graphId>: a graph's own fields (not its nodes) and its node graph
// variable nodes (Set / Get Node Graph Variable), decoded, to learn how the editor writes a graph variable.
import fs from 'node:fs';
import {parseMessage} from 'genshin-ts/injector/binary';
import {buildNodeGraphFieldIndex} from 'genshin-ts/injector/node_graph';
import {loadGiaProto} from 'genshin-ts/injector/proto';
const [file,gid]=process.argv.slice(2);
const bytes=fs.readFileSync(file),payload=bytes.subarray(20,-4),fields=[];
parseMessage(payload,0,payload.length,0,0,0,0,0,0,0,fields);
const {nodeGraphMessage}=loadGiaProto();
for(const [id,matches] of buildNodeGraphFieldIndex(payload,fields))for(const m of matches){
  if(Number(id)!==Number(gid))continue;
  const g=nodeGraphMessage.toObject(nodeGraphMessage.decode(payload.subarray(m.field.dataStart,m.field.dataEnd)),{defaults:false,longs:String,enums:String});
  const {nodes,...rest}=g;
  console.log('GRAPH', JSON.stringify(rest).slice(0,3000));
  for(const n of nodes){const s=JSON.stringify(n);if(/probeSlot/.test(s))console.log('NODE',s.slice(0,1500));}
}
