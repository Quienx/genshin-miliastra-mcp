import {fields} from './wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';

// Composite nodes (复合节点): nodes a creator makes in the editor out of a piece of a graph (select nodes, 生成复合节点)
// and then uses like any other node, in server graphs. A save keeps one in three places of its section 10, read here
// with the pinned protocol's own messages (found 2026-11-15 by wrapping 71 nodes of a graph by hand and comparing the
// save before and after):
//   group 2  a definition (CompositeDef) whose type is Composite (1000; a signal's send and monitor nodes are
//            definitions of other types): its node id, the id of its inner graph, its name and its pins;
//   group 4  the inner graph (a NodeGraph of kind CompositeGraph, 21002), which holds the wrapped nodes;
//   group 1  the graphs that use it: a node whose id is the definition's, with compositePinIndex on its pins.
// In the graph that uses it a composite node is one node (73 nodes became 2), which is what the editor counts
// against its limit; the inner graph has a limit of its own (5000, the guide says).
const COMPOSITE=1000;
const messages=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const pin=flow=>({name:flow.name??'',pinIndex:flow.pinIndex??0,...(flow.type?{type:flow.type}:{})});

// The composite nodes of a save. usedBy is filled by whoever has the graphs (inspectBytes).
export function inspectCompositeNodes(payload,editorCount=()=>null){
  const {root,nodeGraphMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef'),groups=messages(payload,10).flatMap(section=>fields(section).filter(f=>f.wire===2));
  const inner=new Map();
  for(const raw of groups.filter(g=>g.id===4).flatMap(g=>messages(g.data,1))){
    try{const graph=nodeGraphMessage.decode(raw);inner.set(String(graph.id?.id),graph);}catch{}
  }
  return groups.filter(g=>g.id===2).flatMap(g=>messages(g.data,1)).flatMap(raw=>{
    let def;
    try{def=Def.toObject(Def.decode(raw),{longs:String,enums:String});}catch{return [];}
    if(def.type?.kind!=='Composite'&&Number(def.type?.kind)!==COMPOSITE)return [];
    const graphId=String(def.id?.graphId?.id??''),graph=inner.get(graphId);
    return [{definitionId:Number(def.id?.genericId?.id??def.id?.concreteId?.id??0),name:def.name??'',description:def.description??'',graphId:Number(graphId)||null,
      inflows:(def.inflows??[]).map(pin),outflows:(def.outflows??[]).map(pin),inputs:(def.inputs??[]).map(pin),outputs:(def.outputs??[]).map(pin),
      graph:graph?{nodeCount:graph.nodes?.length||0,editorCount:editorCount(graph),exposedPins:graph.compositePins?.length||0}:null,usedBy:[]}];
  });
}
