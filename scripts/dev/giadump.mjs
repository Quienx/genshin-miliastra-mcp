// node scripts/dev/giadump.mjs <graph.gia>: every node of a compiled graph with its pins and connections (short).
import fs from 'node:fs';
import {loadGiaGraph} from 'genshin-ts/injector/node_graph';
import {loadGiaProto} from 'genshin-ts/injector/proto';
const proto=loadGiaProto(),graph=proto.nodeGraphMessage.toObject(loadGiaGraph(fs.readFileSync(process.argv[2]),proto.rootMessage,proto.nodeGraphMessage),{defaults:false,longs:String,enums:String});
for(const n of graph.nodes??[]){
  console.log('NODE',n.nodeIndex,'generic',n.genericId?.nodeId,'concrete',n.concreteId?.nodeId,n.genericId?.kind);
  for(const p of n.pins??[])console.log('   ',JSON.stringify({kind:p.i1?.kind,index:p.i1?.index,type:p.type,value:p.value?.bString?.val??p.value?.bInt?.val??(p.value?'…':undefined),connects:(p.connects??[]).map(c=>[c.id,c.connect?.kind,c.connect?.index??0]),compositePinIndex:p.compositePinIndex}));
}
