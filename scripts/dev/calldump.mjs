// Print, from a save, the graph of a given id (section 10 group 1) with every node's pins and connections, and the
// composite definition and inner graph that a node of it uses.
import fs from 'node:fs';
import {container,fields} from '../../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
const [file,wanted]=process.argv.slice(2);
const {root,nodeGraphMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef');
const messages=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const payload=container(fs.readFileSync(file)),groups=messages(payload,10).flatMap(section=>fields(section).filter(f=>f.wire===2));
const show=o=>JSON.stringify(o,(k,v)=>typeof v==='bigint'?String(v):v);
for(const g of groups.filter(g=>g.id===1||g.id===4)){
  for(const raw of messages(g.data,1)){
    let graph;try{graph=nodeGraphMessage.toObject(nodeGraphMessage.decode(raw),{longs:String,enums:String,defaults:false});}catch{continue;}
    if(String(graph.id?.id)!==wanted)continue;
    console.log('GRAPH group',g.id,'id',graph.id?.id,'name',graph.name,'nodes',(graph.nodes??[]).length, 'keys',Object.keys(graph).join(','));
    if(graph.compositePins)console.log(' compositePins',show(graph.compositePins).slice(0,1500));
    for(const n of graph.nodes??[]){
      console.log(' NODE',n.nodeIndex,'generic',show(n.genericId),'concrete',show(n.concreteId));
      for(const p of n.pins??[])console.log('   PIN',show(p).slice(0,700));
    }
  }
}
for(const raw of groups.filter(g=>g.id===2).flatMap(g=>messages(g.data,1))){
  let def;try{def=Def.toObject(Def.decode(raw),{longs:String,enums:String});}catch{continue;}
  if(def.name==='SSCountHeld')console.log('DEF',show(def).slice(0,2500));
}
