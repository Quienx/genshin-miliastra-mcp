import {fields,field} from './wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';

// Making a composite node (复合节点) out of a graph of the save, as the editor does when a creator selects nodes of a
// graph and picks 生成复合节点. What the editor writes was read from two saves before and after a creator did that
// by hand (2026-11-15, "Copy Slots" and "SSCountHeld"; composite-nodes.mjs says where the three records are):
//   - the selected nodes go, as they are, into a new inner graph (kind CompositeGraph), without the connections that
//     crossed the selection's edge; compositePins lists, for each pin of the new node, the inner node and pin it is;
//   - a definition gets a pin for each of them, numbered on from the highest pin number the save's definitions use
//     (the counter the signals' definitions share), and an id one after the highest definition id;
//   - in the graph one node of that definition takes the place of the selected ones, wired to what stayed outside.
// The selection here is every node but the event node the graph starts with and the tail: the printString nodes
// the flow ends in, with the nodes that only feed them. So the source of such a graph reads as the node does:
//   .onSignal(S,(evt,f)=>{ ...body...; f.printString(f.dataTypeConversion(result,'str')) })
// what S carries are the inputs (named as S names them), the flow into the print is the flow out, and what the
// print is given from the body are the outputs. A body with no print after it leaves by its last node, the one whose
// flow goes nowhere; where there are several such (the last statement is an if, or a loop) the node has no flow out
// and a graph that calls it stops there: end such a body with f.printString('done').
const IN_FLOW=1,OUT_FLOW=2,IN_PARAM=3,OUT_PARAM=4,PRINT=1,BASE=1610612736,COMPOSITE=1000;
const messages=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const sub=(b,id)=>b?fields(b).find(f=>f.id===id&&f.wire===2)?.data:undefined;
const num=(b,id)=>{const f=b?fields(b).find(x=>x.id===id&&x.wire===0):undefined;return f?Number(f.value):0;};
const at=p=>p?.index||0;
// A pin's place. The place 0 is left out, as the editor leaves it: an own property is written even when it is 0.
const end=(kind,index)=>({kind,...(index?{index}:{})});
const turn=(wire,id,kind,index)=>{wire.id=id;for(const side of [wire.connect,wire.connect2])if(side){side.kind=kind;if(index)side.index=index;else delete side.index;}};

// A composite node's definition, as the editor stores one. Pins: {name, pinIndex, type}; type is the definition's own
// message for a pin's type (or its fields as an object).
export function compositeDefinition({definitionId,graphId,name,description,inflow,outflow,inputs=[],outputs=[]}){
  const Def=loadGiaProto().root.lookupType('CompositeDef'),head={class:'SystemDefined',type:'BasicNode',kind:'SysGraph',id:definitionId};
  const flow=(kind,p)=>({...(p.name?{name:p.name}:{}),visible:true,index:{kind},description:'',pinIndex:p.pinIndex});
  const data=(kind,p,i)=>({name:p.name,visible:true,index:end(kind,i),type:p.type,pinIndex:p.pinIndex});
  return Buffer.from(Def.encode(Def.fromObject({id:{genericId:head,concreteId:{...head},graphId:{class:'UserDefined',type:'BasicNode',kind:'CompositeGraph',id:graphId}},
    inflows:[flow('InFlow',inflow)],outflows:outflow?[flow('OutFlow',outflow)]:[],inputs:inputs.map((p,i)=>data('InParam',p,i)),outputs:outputs.map((p,i)=>data('OutParam',p,i)),
    type:{kind:'Composite'},name,...(description?{description}:{}),xxx:6})).finish());
}

// section: the bytes of the save's section 10. typeOf(code): the bytes of a definition pin's type for a pin type of
// a graph (the signals' own table knows them), or null. outside: the node indexes left out of the node, in place of
// the rule above. A composite node of this name that the save has already is made again in place: it keeps its id,
// its inner graph's id and the numbers of the pins it had, so the graphs that call it stay as they are.
export function makeCompositeNode(section,{graphId,name,description,outside},typeOf,fail){
  const {root,nodeGraphMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef'),Node=nodeGraphMessage.fields.nodes.resolve().resolvedType;
  const PinType=Def.fields.inputs.resolve().resolvedType.fields.type.resolve().resolvedType,parts=fields(section);
  let carrier=null,graph=null;
  for(const part of parts.filter(f=>f.id===1&&f.wire===2))for(const raw of messages(part.data,1)){
    let g;try{g=nodeGraphMessage.decode(raw);}catch{continue;}
    if(Number(String(g.id?.id))===graphId){carrier={part,raw};graph=g;}
  }
  if(!graph)fail('GRAPH_NOT_FOUND','The save has no node graph with this id.',{graphId});
  if(!Buffer.from(nodeGraphMessage.encode(graph).finish()).equals(carrier.raw))fail('COMPOSITE_GRAPH_UNREADABLE','This graph holds something the tool does not read back as it is stored, so it is not rewritten.',{graphId});
  const nodes=graph.nodes??[],pinsOf=n=>n.pins??[],flowsOut=n=>pinsOf(n).filter(p=>p.i1?.kind===OUT_FLOW).flatMap(p=>p.connects??[]),reached=new Set(nodes.flatMap(n=>flowsOut(n).map(c=>c.id)));
  const events=nodes.filter(n=>!reached.has(n.nodeIndex)&&flowsOut(n).length);
  if(events.length!==1)fail('COMPOSITE_GRAPH_SHAPE','A composite node is made of a graph with one event (one .onSignal or one .on): its body becomes the node.',{graphId,events:events.length});
  const out=new Set([events[0].nodeIndex]);
  if(outside){for(const i of outside)out.add(i);}
  else{
    // The tail: prints the flow ends in (a print that leads only to such prints is one too), then what only feeds the tail.
    const readers=n=>nodes.filter(o=>pinsOf(o).some(p=>p.i1?.kind===IN_PARAM&&(p.connects??[]).some(c=>c.id===n.nodeIndex)));
    for(let grew=true;grew;){grew=false;for(const n of nodes){
      if(out.has(n.nodeIndex))continue;
      const print=n.genericId?.nodeId===PRINT&&reached.has(n.nodeIndex)&&flowsOut(n).every(c=>out.has(c.id)),pure=!reached.has(n.nodeIndex)&&!flowsOut(n).length,read=readers(n);
      if(print||(pure&&read.length&&read.every(o=>out.has(o.nodeIndex)&&o!==events[0]))){out.add(n.nodeIndex);grew=true;}
    }}
  }
  const inside=nodes.filter(n=>!out.has(n.nodeIndex)).sort((a,b)=>a.nodeIndex-b.nodeIndex);
  if(!inside.length)fail('COMPOSITE_GRAPH_SHAPE','Nothing is left to put into the node: the graph is an event and its tail only.',{graphId});
  // What crosses the edge. A flow is stored on the pin it leaves, a value on the pin that reads it.
  const flowsIn=[],exits=[],inputs=[],reads=[];
  for(const n of nodes)for(const p of pinsOf(n))for(const wire of p.connects??[]){
    const outer=out.has(n.nodeIndex);
    if(outer===out.has(wire.id))continue;
    if(p.i1?.kind===OUT_FLOW)(outer?flowsIn:exits).push({node:n,pin:p,wire});
    else if(p.i1?.kind===IN_PARAM)(outer?reads:inputs).push({node:n,pin:p,wire,key:wire.id+':'+at(wire.connect)});
  }
  if(flowsIn.length!==1)fail('COMPOSITE_GRAPH_SHAPE','The node needs one flow into it: the event has to lead to one node of the body.',{graphId,flowsIn:flowsIn.length});
  const leaves=[...new Set(exits.map(e=>e.node.nodeIndex+':'+at(e.pin.i1)))];
  if(leaves.length>1)fail('COMPOSITE_GRAPH_SHAPE','The body leaves towards its tail from '+leaves.length+' places, and a node made here has one flow out: end the body with a statement that always runs.',{graphId,exits:leaves});
  // Where the flow leaves the node: the pin that led to the tail or, with nothing after the body, the one node of
  // the body whose flow goes nowhere (as the editor did for "Copy Slots", a body with nothing after it).
  const ends=inside.filter(n=>reached.has(n.nodeIndex)&&!flowsOut(n).length);
  const exit=exits.length?{node:exits[0].node.nodeIndex,pin:at(exits[0].pin.i1)}:ends.length===1?{node:ends[0].nodeIndex,pin:0}:null;
  const shared=inputs.map(x=>x.key).filter((k,i,a)=>a.indexOf(k)!==i);
  if(shared.length)fail('COMPOSITE_INPUT_SHARED','A value of the event is used in more than one place of the body, and an input of a composite node is one pin of one inner node: keep the value in a variable first (let x = evt.params.x) and use that.',{graphId,sources:[...new Set(shared)]});
  inputs.sort((a,b)=>a.wire.id-b.wire.id||at(a.wire.connect)-at(b.wire.connect));
  // shortcut: outputs come in the order of the nodes that read them, which is the order of the prints only as far as
  // the compiler numbers nodes in the order of the source; walk the tail's flow when a node gives out more than one value.
  const outputs=[];
  for(const r of reads.sort((a,b)=>a.node.nodeIndex-b.node.nodeIndex||at(a.pin.i1)-at(b.pin.i1))){
    const known=outputs.find(o=>o.key===r.key);
    if(known)known.reads.push(r);else outputs.push({key:r.key,node:r.wire.id,pin:at(r.wire.connect),code:r.pin.type,reads:[r]});
  }
  // The definitions the save has: ids, pin numbers, names of what the event carries, and a node of this name.
  const defs=parts.filter(f=>f.id===2&&f.wire===2).flatMap(part=>messages(part.data,1).map(raw=>({part,raw,id:num(sub(sub(raw,4),1),5)})));
  let serial=0;for(const d of defs)for(const pin of fields(d.raw).filter(f=>f.wire===2&&f.id>=100&&f.id<=106))serial=Math.max(serial,num(pin.data,8));
  const composites=defs.flatMap(d=>{try{const def=Def.decode(d.raw);return def.type?.kind===COMPOSITE?[{...d,def}]:[];}catch{return [];}});
  const same=composites.filter(c=>c.def.name===name),old=same[0];
  if(same.length>1)fail('COMPOSITE_NODE_AMBIGUOUS','The save has several composite nodes of this name.',{name});
  const inner=parts.filter(f=>f.id===4&&f.wire===2).flatMap(part=>messages(part.data,1).map(raw=>{try{return {part,id:Number(String(nodeGraphMessage.decode(raw).id?.id))};}catch{return {part,id:0};}}));
  const definitionId=old?old.id:Math.max(BASE,...defs.map(d=>d.id))+1,innerId=old?Number(String(old.def.id?.graphId?.id)):Math.max(BASE,...inner.map(g=>g.id))+1;
  const kept=(list,i)=>old?.def[list]?.[i]?.pinIndex,fresh=()=>++serial,number=(list,i)=>kept(list,i)||fresh();
  const typed=(code,what)=>{const bytes=typeOf(code);if(!bytes)fail('COMPOSITE_PIN_TYPE','A pin of the node has a type the tool has no definition type for.',{graphId,pin:what,type:code??null});return PinType.decode(bytes);};
  let carried=[];try{carried=Def.decode(defs.find(d=>d.id===events[0].genericId?.nodeId)?.raw??Buffer.alloc(0)).outputs??[];}catch{}
  const spec={definitionId,graphId:innerId,name,description,inflow:{pinIndex:number('inflows',0)},outflow:exit?{pinIndex:number('outflows',0)}:null,
    inputs:inputs.map((x,i)=>({name:(x.wire.id===events[0].nodeIndex&&carried.find(o=>at(o.index)===at(x.wire.connect))?.name)||'Input '+(i+1),pinIndex:number('inputs',i),type:typed(x.pin.type,'input '+(i+1))})),
    outputs:outputs.map((o,i)=>({name:outputs.length>1?'Result '+(i+1):'Result',pinIndex:number('outputs',i),type:typed(o.code,'output '+(i+1))}))};
  // The node that takes the body's place, and the wires of what stays outside turned to it.
  const index=inside[0].nodeIndex,id={class:10001,type:20000,kind:22001,nodeId:definitionId},wired=w=>({id:w.id,connect:end(w.connect.kind,at(w.connect)),connect2:end(w.connect.kind,at(w.connect))});
  const entry={node:flowsIn[0].wire.id,pin:at(flowsIn[0].wire.connect)};
  const node=Node.fromObject({nodeIndex:index,genericId:id,concreteId:{...id},pins:[
    ...(exits.length?[{i1:end(OUT_FLOW),i2:end(OUT_FLOW),connects:exits.map(e=>wired(e.wire)),compositePinIndex:spec.outflow.pinIndex}]:[]),
    ...inputs.map((x,i)=>({i1:end(IN_PARAM,i),i2:end(IN_PARAM,i),type:x.pin.type,connects:[wired(x.wire)],compositePinIndex:spec.inputs[i].pinIndex}))],
    x:inside.reduce((s,n)=>s+(n.x||0),0)/inside.length,y:inside.reduce((s,n)=>s+(n.y||0),0)/inside.length});
  turn(flowsIn[0].wire,index,IN_FLOW,0);
  outputs.forEach((o,i)=>o.reads.forEach(r=>turn(r.wire,index,OUT_PARAM,i)));
  for(const x of [...inputs,...exits])x.pin.connects=x.pin.connects.filter(w=>w!==x.wire);
  graph.nodes=[...nodes.filter(n=>out.has(n.nodeIndex)),node].sort((a,b)=>a.nodeIndex-b.nodeIndex);
  const pinOf=(outer,nodeId,kind,place)=>({outerPin:outer,innerNodeId:nodeId,innerPin:end(kind,place),innerPin2:end(kind,place)});
  const innerGraph=nodeGraphMessage.fromObject({id:{class:'UserDefined',type:'BasicNode',kind:'CompositeGraph',id:innerId},compositePins:[
    pinOf(end(IN_FLOW),entry.node,IN_FLOW,entry.pin),...(exit?[pinOf(end(OUT_FLOW),exit.node,OUT_FLOW,exit.pin)]:[]),
    ...inputs.map((x,i)=>pinOf(end(IN_PARAM,i),x.node.nodeIndex,IN_PARAM,at(x.pin.i1))),...outputs.map((o,i)=>pinOf(end(OUT_PARAM,i),o.node,OUT_PARAM,o.pin))]});
  innerGraph.nodes=inside;
  // The section again: the graph in its place, the definition after the last one (or in the old one's place), the
  // inner graph after the last inner graph, which is after the group 3 and before the signals' register.
  const record=(id,bytes)=>field(id,2,field(1,2,bytes)),definition=record(2,compositeDefinition(spec)),held=record(4,Buffer.from(nodeGraphMessage.encode(innerGraph).finish()));
  const oldGraph=old?inner.find(g=>g.id===innerId)?.part:null;
  const list=parts.map(part=>part===carrier.part?field(1,2,Buffer.concat(fields(part.data).map(f=>f.id===1&&f.wire===2&&f.data.equals(carrier.raw)?field(1,2,Buffer.from(nodeGraphMessage.encode(graph).finish())):f.raw)))
    :old&&part===old.part?definition:oldGraph&&part===oldGraph?held:part.raw);
  if(!old)list.splice(parts.findLastIndex(f=>f.id===2&&f.wire===2)+1,0,definition);
  if(!oldGraph){const ids=parts.map(f=>f.id);if(!old)ids.splice(ids.lastIndexOf(2)+1,0,2);list.splice(ids.findLastIndex(i=>i<=4)+1,0,held);}
  return {section:Buffer.concat(list),report:{name,definitionId,innerGraphId:innerId,replaced:Boolean(old),nodes:inside.length,nodeIndex:index,
    inputs:spec.inputs.map(p=>({name:p.name,pinIndex:p.pinIndex})),outputs:spec.outputs.map(p=>({name:p.name,pinIndex:p.pinIndex})),flowOut:Boolean(spec.outflow),left:[...out].sort((a,b)=>a-b)}};
}
