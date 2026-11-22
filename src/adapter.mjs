import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseMessage, readUint32BE } from 'genshin-ts/injector/binary';
import { buildNodeGraphFieldIndex, isNodeGraphEmptyForInjection, loadGiaGraph } from 'genshin-ts/injector/node_graph';
import { loadGiaProto } from 'genshin-ts/injector/proto';
import { createInjector } from 'genshin-ts/injector/index';
import { buildSignalNodeIdMapFromFields } from 'genshin-ts/injector/signal_nodes';
import { inspectEntities } from './scene/inspect.mjs';
import { inspectBattleConfigurations } from './scene/battle-config.mjs';
import { inspectUIConfigurations } from './scene/ui-config.mjs';
import {signalDefinitionFingerprints,clientScriptSignalHeads} from './scene/signal-definitions.mjs';
import {inspectSignalContract} from './scene/signal-contract.mjs';
import {inspectPrefabs} from './scene/prefabs.mjs';
import {inspectCompositeNodes} from './scene/composite-nodes.mjs';
import {inspectStructs,structVariablesNamed,STRUCT_FIELD_TYPES} from './scene/struct-make.mjs';
import {eventNodeIds} from './scene/graph-read.mjs';

export const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('genshin-ts/package.json')));
export const sha = value => createHash('sha256').update(value).digest('hex');
export function fail(code, message, details={}) { throw Object.assign(new Error(message), {code, details}); }
export function graphNodePayloadHash(graph,nodeGraphMessage=loadGiaProto().nodeGraphMessage) {
  // Official saves omit protobuf scalar defaults. Materialize them before comparing.
  // This covers nodes (including pins, connections and layout), not bindings or gameplay.
  return sha(JSON.stringify(nodeGraphMessage.toObject(graph,{defaults:true,longs:String,enums:String}).nodes));
}
// What the editor's size check adds up for a graph (校验失败：服务器内存消耗过高；节点图中的节点数超标：N). Every node counts
// one, except that reading or writing a graph variable counts 4, a loop over a list 20 and a counting loop (finiteLoop)
// 15. Measured 2026-10-10
// with graphs of one construct each (scripts/dev/gen_count.py: the editor names its number when it refuses a graph), and
// the sum then matched the editor's number exactly on two whole game graphs of 60 node types (2229 nodes -> 3194,
// 2259 -> 3600). Found to count one: print, branch, arithmetic, comparison, type conversion, local variables, list
// literals, list item lookup, entity queries and positions, creating and removing entities, timers, effects, an entity's
// custom variable being set. Keys are generic node ids: 323 sets a graph variable, 337 gets one, 509 loops over a list,
// 5 is finiteLoop.
export const EDITOR_NODE_WEIGHTS={323:4,337:4,509:20,5:15};
export function graphEditorCount(graph) {
  const seen={};let total=0;
  for(const node of graph.nodes??[]){
    const id=Number(String(node.genericId?.nodeId??node.concreteId?.nodeId??0)),weight=EDITOR_NODE_WEIGHTS[id]??1;
    total+=weight;if(weight>1)seen[id]=(seen[id]||0)+1;
  }
  return {total,variableReads:seen[337]||0,variableWrites:seen[323]||0,listLoops:seen[509]||0,countingLoops:seen[5]||0};
}
export function graphTopology(graph,nodeGraphMessage=loadGiaProto().nodeGraphMessage) {
  const obj=nodeGraphMessage.toObject(graph,{defaults:true,longs:String,enums:String});
  const id=x=>[x?.class??0,x?.type??0,x?.kind??0,x?.nodeId??0];
  const pin=x=>[x?.kind??0,x?.index??0];
  const ordered=rows=>rows.map(row=>JSON.stringify(row)).sort();
  const nodes=(obj.nodes??[]).map(n=>[n.nodeIndex,id(n.genericId),id(n.concreteId)]);
  const edges=(obj.nodes??[]).flatMap(n=>(n.pins??[]).flatMap(p=>(p.connects??[]).map(c=>[n.nodeIndex,...pin(p.i1),c.id,...pin(c.connect)])));
  return {version:1,nodeCount:nodes.length,connectionCount:edges.length,hash:sha(JSON.stringify({nodes:ordered(nodes),edges:ordered(edges)})),scope:'Node indices, generic/concrete IDs and directed pin connections only; excludes layout, literal values, pin types, graph variables, bindings and runtime'};
}
export function inspectBytes(bytes) {
  if(bytes.length<24 || readUint32BE(bytes,8)!==0x326 || readUint32BE(bytes,bytes.length-4)!==0x679)
    fail('INVALID_GIL','Invalid GIL header or footer.');
  if(readUint32BE(bytes,16)!==bytes.length-24) fail('INVALID_GIL','GIL payload length mismatch.');
  const payload=bytes.subarray(20,-4), fields=[];
  parseMessage(payload,0,payload.length,0,0,0,0,0,0,0,fields);
  const signals=[...buildSignalNodeIdMapFromFields(payload,fields)].map(([name,nodeIds])=>({name,nodeIds}));
  const definitionFingerprints=signalDefinitionFingerprints(payload,fields,signals);
  for(const signal of signals){signal.definitionFingerprints=definitionFingerprints.get(signal.name);signal.parameterContract=inspectSignalContract(signal);}
  const {nodeGraphMessage}=loadGiaProto();
  // Composite nodes (复合节点) and, on each graph, the nodes that are one: by the definition's id.
  const compositeNodes=inspectCompositeNodes(payload,graph=>graphEditorCount(graph).total),composite=new Map(compositeNodes.map(c=>[c.definitionId,c]));
  const graphs=[...buildNodeGraphFieldIndex(payload,fields)].flatMap(([id,matches])=>matches.map(m=>{
    const obj=nodeGraphMessage.decode(payload.subarray(m.field.dataStart,m.field.dataEnd));
    const compositeNodeRefs=(obj.nodes??[]).flatMap(node=>{const used=composite.get(Number(String(node.genericId?.nodeId??0)));if(!used)return [];
      used.usedBy.push({graphId:id,graphName:obj.name||'',nodeIndex:node.nodeIndex});return [{nodeIndex:node.nodeIndex,definitionId:used.definitionId,name:used.name}];});
    const signalReferences=(obj.nodes??[]).flatMap(node=>signals.flatMap(signal=>Object.entries(signal.nodeIds).filter(([,target])=>['class','type','kind','nodeId'].every(k=>node.genericId?.[k]===target[k])).map(([role,target])=>({name:signal.name,role,nodeIndex:node.nodeIndex,nodeId:target.nodeId,signalVersion:node.signalVersion??null,resolution:'observed-definition-id-match',gameplay:'not_run'}))));
    return {id,name:obj.name||'',type:m.type,nodeCount:obj.nodes?.length||0,editorCount:graphEditorCount(obj).total,nodePayloadHash:graphNodePayloadHash(obj,nodeGraphMessage),topology:graphTopology(obj,nodeGraphMessage),signalReferences,
      ...(compositeNodeRefs.length?{compositeNodeRefs}:{}),writable:isNodeGraphEmptyForInjection(obj)||(obj.name||'').startsWith('_GSTS')};
  }));
  const structs=inspectStructs(payload).map(({assemble,...s})=>s);
  return {bytes:bytes.length,sha256:sha(bytes),schema:readUint32BE(bytes,4),graphs,compositeNodes,...(structs.length?{structs}:{}),signals,prefabTemplates:inspectPrefabs(payload),battleConfigurations:inspectBattleConfigurations(payload),uiConfigurations:inspectUIConfigurations(payload),signalInspection:{scope:'Pinned backend signal definition node IDs and matching graph references; parameter schema and runtime not verified'},entities:inspectEntities(payload),
    warnings:graphs.length?[]:[{code:'MISSING_GRAPH',message:'Create and save a server entity node graph named _GSTS_MCP_Test in the editor, and attach it to the stage entity.'}]};
}
export function inspectFile(file) { return {path:file,modifiedAt:fs.statSync(file).mtime.toISOString(),...inspectBytes(fs.readFileSync(file))}; }
export function inspectGia(bytes) {
  const proto=loadGiaProto();
  const graph=loadGiaGraph(bytes,proto.rootMessage,proto.nodeGraphMessage);
  return {id:Number(graph.id.id),name:graph.name,nodeCount:graph.nodes?.length||0,editorCount:graphEditorCount(graph),type:Number(graph.id.type),kind:Number(graph.id.kind),nodePayloadHash:graphNodePayloadHash(graph,proto.nodeGraphMessage),topology:graphTopology(graph,proto.nodeGraphMessage)};
}
// A signal to the client scripts (Lua) of one player. The compiler has no node for it (发送客户端脚本信号, new in game
// 7.1), but the node is the send node of the signal in all but the definition it names: the name of the signal, then
// the player as its first data pin and the parameters after (read from a node placed and wired by hand, 2026-10-13).
// So a graph writes f.sendSignal('client:NAME', player, ...parameters), and here, before the graph goes into the save,
// such a node is given the definition 发送客户端脚本信号 of NAME in that save and the name without the prefix.
const CLIENT_SIGNAL=/^client:/;
function textOf(value){return typeof value?.bString?.val==='string'?value.bString:value?.bConcreteValue?.value?textOf(value.bConcreteValue.value):null;}
export function toClientScriptSignals(gilBytes,giaBytes){
  const {rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const named=(graph?.nodes??[]).filter(n=>n.genericId?.nodeId===300000).map(n=>({node:n,text:(n.pins??[]).filter(p=>p?.i1?.kind===5).map(p=>textOf(p.value)).find(Boolean)})).filter(x=>x.text&&CLIENT_SIGNAL.test(x.text.val));
  if(!named.length)return giaBytes;
  const heads=clientScriptSignalHeads(gilBytes);
  for(const {node,text} of named){
    const name=text.val.replace(CLIENT_SIGNAL,''),head=heads.get(name);
    if(!head)fail('SIGNAL_NOT_FOR_CLIENT_SCRIPTS',heads.size||listedSignals(gilBytes).includes(name)?'The save has no definition 发送客户端脚本信号 for this signal: the signal was defined before game 7.1. Open the save in the editor and save it once (the editor adds the definition), or define the signal with scene_add_signal on a copy.':'The save has no signal of this name: scene_add_signal defines it.',{signal:name,sentAs:text.val,signals:[...heads.keys()]});
    // The player is the first data pin: without it the node sends to nobody.
    if(!(node.pins??[]).some(p=>p?.i1?.kind===3&&!(p.i1.index>0)))fail('SIGNAL_WITHOUT_PLAYER','A signal to client scripts names the player it goes to: f.sendSignal(\'client:'+name+'\', player, ...).',{signal:name});
    for(const id of [node.genericId,node.concreteId])if(id)Object.assign(id,head);
    text.val=name;
  }
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,giaBytes.subarray(-4)]);
}
// A call to a composite node (复合节点) that the save already has. The compiler has no node for one, but in a graph a
// composite node is a node like the send node of a signal: the definition's id, then its data pins in order, each
// naming its pin of the definition (compositePinIndex), and the flow out naming the definition's (read from a node a
// creator placed by wrapping part of a graph, 2026-11-15). So a graph writes f.sendSignal('composite:NAME', ...inputs)
// and here, before the graph goes into the save, such a node becomes the composite node NAME of that save: its id,
// no pin for a name, and the pins numbered as the definition has them.
// What the composite node gives out: a send has no outputs, so the graph reads an output with a stand-in that the
// compiler can type, f.getCustomVariable(anyEntity, 'composite:NAME:K').asType(...), K the output's place from 0,
// written AFTER the call it reads (it reads the last call of NAME before it). In a save a node that uses a composite
// node's output is simply connected to that node's output K, with nothing else stored (read from a composite node
// with an output that a creator made, 2026-11-15); so here every such connection is turned to the call's node and
// the stand-in is taken out. Its type must be the output's.
const COMPOSITE_CALL=/^composite:/,COMPOSITE_OUTPUT=/^composite:(.+):(\d+)$/,GET_CUSTOM_VARIABLE=50;
export function toCompositeNodes(gilBytes,giaBytes){
  const {rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const named=(graph?.nodes??[]).filter(n=>n.genericId?.nodeId===300000).map(n=>({node:n,text:(n.pins??[]).filter(p=>p?.i1?.kind===5).map(p=>textOf(p.value)).find(Boolean)})).filter(x=>x.text&&COMPOSITE_CALL.test(x.text.val));
  const reads=(graph?.nodes??[]).filter(n=>n.genericId?.nodeId===GET_CUSTOM_VARIABLE).map(n=>({node:n,match:COMPOSITE_OUTPUT.exec((n.pins??[]).filter(p=>p?.i1?.kind===3&&(p.i1.index||0)===1).map(p=>textOf(p.value)).find(Boolean)?.val??'')})).filter(x=>x.match);
  if(!named.length&&!reads.length)return giaBytes;
  const known=inspectCompositeNodes(gilBytes.subarray(20,-4)),calls=[];
  for(const {node,text} of named){
    const name=text.val.replace(COMPOSITE_CALL,''),found=known.filter(c=>c.name===name),[def]=found;
    if(found.length!==1)fail(found.length?'COMPOSITE_NODE_AMBIGUOUS':'COMPOSITE_NODE_NOT_FOUND',found.length?'The save has several composite nodes of this name: give them different names in the editor.':'The save has no composite node of this name. scene_add_composite_node makes one out of a graph (or a creator does, in the editor: select the nodes of a graph, 生成复合节点); inspect_map lists those a save has.',{compositeNode:name,calledAs:text.val,compositeNodes:known.map(c=>c.name)});
    const inputs=(node.pins??[]).filter(p=>p?.i1?.kind===3).sort((a,b)=>(a.i1.index||0)-(b.i1.index||0));
    if(inputs.length!==def.inputs.length||inputs.some((p,i)=>(p.i1.index||0)!==i))fail('COMPOSITE_NODE_INPUTS','The call gives '+inputs.length+' input(s) and the composite node takes '+def.inputs.length+': f.sendSignal(\'composite:'+name+'\''+def.inputs.map(p=>', '+(p.name||'input')).join('')+').',{compositeNode:name,inputs:def.inputs.map(p=>({name:p.name,type:p.type}))});
    if(def.inflows.length!==1||def.outflows.length>1)fail('COMPOSITE_NODE_FLOW','Only a composite node with one flow in and at most one flow out can be called from a graph\'s source.',{compositeNode:name,inflows:def.inflows.length,outflows:def.outflows.length});
    const id={class:10001,type:20000,kind:22001,nodeId:def.definitionId};
    node.genericId=id;node.concreteId={...id};
    node.pins=(node.pins??[]).filter(p=>p?.i1?.kind!==5);
    inputs.forEach((p,i)=>{p.compositePinIndex=def.inputs[i].pinIndex;});
    for(const p of node.pins)if(p?.i1?.kind===2&&def.outflows.length)p.compositePinIndex=def.outflows[0].pinIndex;
    calls.push({node,name,def});
  }
  const types=loadGiaProto().root.lookupEnum('VarType').values;
  for(const {node,match:[,name,place]} of reads){
    const call=calls.filter(c=>c.name===name&&c.node.nodeIndex<node.nodeIndex).sort((a,b)=>b.node.nodeIndex-a.node.nodeIndex)[0],output=call?.def.outputs[Number(place)],made=(node.pins??[]).find(p=>p?.i1?.kind===4)?.type;
    const read="f.getCustomVariable(entity, 'composite:"+name+':'+place+"')";
    if(!call)fail('COMPOSITE_NODE_OUTPUT','An output of a composite node is read after the call that makes it: write f.sendSignal(\'composite:'+name+'\', ...) first, then '+read+'.',{compositeNode:name,output:Number(place)});
    if(!output)fail('COMPOSITE_NODE_OUTPUT','The composite node has '+call.def.outputs.length+' output(s), counted from 0.',{compositeNode:name,output:Number(place),outputs:call.def.outputs.map(o=>o.name||'output')});
    if(made!==types[output.type?.type1])fail('COMPOSITE_NODE_OUTPUT','The output is of another type than the source reads it as: give .asType() the output\'s type.',{compositeNode:name,output:Number(place),type:output.type?.type1??null});
    for(const other of graph.nodes)for(const pin of other.pins??[])for(const wire of pin.connects??[])if(wire.id===node.nodeIndex&&wire.connect?.kind===4){
      wire.id=call.node.nodeIndex;wire.connect.index=Number(place);if(wire.connect2)wire.connect2.index=Number(place);
    }
  }
  if(reads.length)graph.nodes=graph.nodes.filter(n=>!reads.some(r=>r.node===n));
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,giaBytes.subarray(-4)]);
}
// No entity. A pin of type entity left empty (a projectile launched without a target to follow: 定点发射投射物's
// 追踪目标, as the editor's own bow graphs leave it) has no literal the compiler can write in a client graph
// (CLIENT_VALUE_TYPE_UNAVAILABLE). So a graph passes f.getCustomVariable(anyEntity, 'entity:none').asType('entity'),
// and here that read is taken out with its wires: the pins it fed are left unwired and empty, as the editor leaves
// them (read from the user's graph "Bow Rapid Shot 01", 2026-11-17: the pin's value is its type alone).
const NO_ENTITY='entity:none',CUSTOM_VARIABLE_READS=new Set([GET_CUSTOM_VARIABLE,200016]);
export function toEmptyEntities(giaBytes){
  const {rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const none=new Set((graph?.nodes??[]).filter(n=>CUSTOM_VARIABLE_READS.has(Number(n.genericId?.nodeId))&&(n.pins??[]).some(p=>p?.i1?.kind===3&&textOf(p.value)?.val===NO_ENTITY)).map(n=>n.nodeIndex));
  if(!none.size)return giaBytes;
  for(const node of graph.nodes)for(const pin of node.pins??[])if(pin.connects?.length)pin.connects=pin.connects.filter(w=>!none.has(w.id));
  graph.nodes=graph.nodes.filter(n=>!none.has(n.nodeIndex));
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,giaBytes.subarray(-4)]);
}
// A structure (结构体, scene_add_struct) built and pushed into a notification queue (消息队列). The compiler has neither
// the Assemble node of a structure nor the fourth input of 更新消息队列 (it knows player, queue and item only). So a
// graph writes f.sendSignal('struct:NAME', ...fields) and then f.refreshNotificationQueue(player, queue, item), and
// here, before the graph goes into the save, the send becomes the structure's Assemble node, as a creator placed one
// (2026-11-17): the definition's id, the fields as its inputs (compositePinIndex), no name pin and no flow, the flow
// going past it; and the next queue node after it gets the structure on its fourth input (InParam 3, type 25), with
// the structure named on the node (usingStruct) and on the graph (an affiliation of type 66002).
// A structure built this way can also be read as a value, for a dictionary or a list of structures (toStructValues):
// f.getCustomVariable(anyEntity, 'struct:NAME:0').asType('int') written after the call (before the next call of NAME)
// reads it, and then no queue node takes it.
const STRUCT_CALL=/^struct:/,STRUCT_READ=/^struct:(.+):(\d+)$/,QUEUE=833;
const valueName=n=>textOf((n.pins??[]).find(p=>p?.i1?.kind===3&&(p.i1.index||0)===1)?.value)?.val??'';
// The flow goes past a node taken out of it: what flowed into it flows where it went.
function flowPast(graph,node,Wire){
  const onward=(node.pins??[]).filter(p=>p?.i1?.kind===2).flatMap(p=>p.connects??[]);
  for(const other of graph.nodes)for(const pin of other.pins??[])if(pin?.i1?.kind===2&&(pin.connects??[]).some(w=>w.id===node.nodeIndex))
    pin.connects=pin.connects.flatMap(w=>w.id===node.nodeIndex?onward.map(o=>Wire.fromObject(Wire.toObject(o))):[w]);
  node.pins=(node.pins??[]).filter(p=>p?.i1?.kind!==2);
}
// Every wire from the output of `read` (a stand-in) goes from output `place` of `to` instead.
function rewire(graph,read,to,place){
  for(const other of graph.nodes)for(const pin of other.pins??[])for(const wire of pin.connects??[])if(wire.id===read.nodeIndex&&wire.connect?.kind===4){
    wire.id=to.nodeIndex;wire.connect.index=place;if(wire.connect2)wire.connect2.index=place;
  }
}
export function toStructNodes(gilBytes,giaBytes){
  const {root:proto,rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const named=(graph?.nodes??[]).filter(n=>n.genericId?.nodeId===300000).map(n=>({node:n,text:(n.pins??[]).filter(p=>p?.i1?.kind===5).map(p=>textOf(p.value)).find(Boolean)})).filter(x=>x.text&&STRUCT_CALL.test(x.text.val));
  const reads=(graph?.nodes??[]).filter(n=>n.genericId?.nodeId===GET_CUSTOM_VARIABLE).map(n=>({node:n,match:STRUCT_READ.exec(valueName(n))})).filter(x=>x.match);
  if(!named.length&&!reads.length)return giaBytes;
  const known=inspectStructs(gilBytes.subarray(20,-4)),Pin=proto.lookupType('NodePin'),Info=proto.lookupType('GraphAffiliation.Info'),Affiliation=proto.lookupType('GraphAffiliation'),Wire=proto.lookupType('NodeConnection');
  const queues=graph.nodes.filter(n=>n.genericId?.nodeId===QUEUE),taken=new Set(),used=new Set(),read=new Set();
  const calls=named.sort((a,b)=>a.node.nodeIndex-b.node.nodeIndex).map(x=>({...x,name:x.text.val.replace(STRUCT_CALL,'')}));
  for(const {node,name} of calls){
    const s=known.find(x=>x.name===name);
    if(!s?.assemble)fail('STRUCT_NOT_FOUND','The save has no structure of this name: scene_add_struct makes one.',{struct:name,structs:known.map(x=>x.name)});
    const inputs=(node.pins??[]).filter(p=>p?.i1?.kind===3).sort((a,b)=>(a.i1.index||0)-(b.i1.index||0));
    if(inputs.length!==s.fields.length)fail('STRUCT_FIELDS','The call gives '+inputs.length+' value(s) and the structure has '+s.fields.length+": f.sendSignal('struct:"+name+"'"+s.fields.map(f=>', <'+f.name+'>').join('')+').',{struct:name,fields:s.fields});
    const next=calls.find(c=>c.name===name&&c.node.nodeIndex>node.nodeIndex),mine=reads.filter(r=>r.match[1]===name&&r.node.nodeIndex>node.nodeIndex&&(!next||r.node.nodeIndex<next.node.nodeIndex));
    const queue=mine.length?null:queues.find(q=>q.nodeIndex>node.nodeIndex&&!taken.has(q));
    if(!mine.length&&!queue)fail('STRUCT_UNUSED',"A structure built with f.sendSignal('struct:"+name+"', ...) goes into the f.refreshNotificationQueue(player, queue, item) written after it, or is read with f.getCustomVariable(entity, 'struct:"+name+":0').asType('int'), and there is neither.",{struct:name});
    flowPast(graph,node,Wire);
    const id={class:10001,type:20000,kind:22001,nodeId:s.assemble.definitionId};
    node.genericId=id;node.concreteId={...id};
    // Each input as the editor writes one on an Assemble node: its field's type on the pin's value too (type_server),
    // without which the editor drops a wire into it and shows the field empty (seen 2026-11-17, a wire from a signal).
    node.pins=inputs.map((p,i)=>{const o=Pin.toObject(p);o.compositePinIndex=s.assemble.pins[i];if(o.value)o.value.itemType={...(o.value.itemType??{}),type_server:{...(o.value.itemType?.type_server??{}),type:o.type}};return Pin.fromObject(o);});
    if(mine.length){
      for(const r of mine){
        if(r.match[2]!=='0'||(r.node.pins??[]).find(p=>p?.i1?.kind===4)?.type!==3)fail('STRUCT_OUTPUT',"An Assemble node has one output, the structure, read as f.getCustomVariable(entity, 'struct:"+name+":0').asType('int').",{struct:name,read:valueName(r.node)});
        rewire(graph,r.node,node,0);read.add(r.node);
      }
      continue;
    }
    taken.add(queue);
    const info={source:{class:10001,type:20000,kind:22000,id:QUEUE},alwaysOneXxxx:1,structId:{structId:s.id}};
    queue.pins=[...(queue.pins??[]).filter(p=>!(p?.i1?.kind===3&&p.i1.index===3)),Pin.fromObject({i1:{kind:3,index:3},i2:{kind:3,index:3},type:25,connects:[{id:node.nodeIndex,connect:{kind:4},connect2:{kind:4}}],
      value:{class:10000,alreadySetVal:true,bConcreteValue:{value:{class:10001,itemType:{classBase:1,type_server:{type:25,kind:1,item:{structId:s.id}}},bStruct:{}},structs:{class:1,inner:{wrapper:{class:10001,item:{structId:s.id}}}}}}})];
    queue.usingStruct=[Info.fromObject(info)];
    if(!used.has(s.id)){used.add(s.id);graph.affiliations=[...(graph.affiliations??[]),Affiliation.fromObject({info,type:{type:66002}})];}
  }
  const stray=reads.find(r=>!read.has(r.node));
  if(stray)fail('STRUCT_OUTPUT',"A structure is read after the call that builds it: write f.sendSignal('struct:"+stray.match[1]+"', ...fields) first.",{read:valueName(stray.node)});
  graph.nodes=graph.nodes.filter(n=>!read.has(n));
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,giaBytes.subarray(-4)]);
}
// Structure values in a graph: variables that hold structures (scene_add_components structList / dict), Split and
// Modify. The compiler has no structure type its nodes take, so a graph's source carries a structure value as an
// integer stand-in, and such a variable as an integer list (structList) or a dictionary of integers (dict):
//   const d = f.getCustomVariable(p, 'bag').asDict('int', 'int')             // bag: Dict<int, ItemInstance>
//   f.sendSignal('split:ItemInstance', f.queryDictionaryValueByKey(d, 1n))    // Split, and after it each field
//   f.getCustomVariable(p, 'split:ItemInstance:1').asType('int')             //   by its place from 0
//   f.sendSignal('modify:ItemInstance', <structure>, 'count', 99n)           // Modify: field names, new values
//   f.listIterationLoop(f.getCustomVariable(p, 'list').asType('int_list'), it => { ... })   // it: a structure
//   f.setOrAddKeyValuePairsToDictionary(d, 3n, <structure>), f.removeKeyValuePairsFromDictionaryByKey(d, 2n)
// (a structure built with struct:NAME and read with 'struct:NAME:0', toStructNodes, is one too). Here, before the
// graph goes into the save, the nodes on such values are typed as the editor types them (read from a creator's graph,
// StructProbe, 2026-11-22): Get / Set Custom Variable, Query Dictionary Value by Key and List Iteration Loop lose their
// concrete id, their pins carry the structure (pin type 25 a structure, 26 a list of one, 27 a dictionary to one),
// and each names it on the node (usingStruct) and on the graph (an affiliation), with numbers that depend on the node.
// Split is a node of the structure's split definition with its one input (outputs are not stored: a wire names one
// by its place); Modify a node of its modify definition with the structure, then for each field set its value pin and
// a yes on its flag pin (the fields not set are left out), and its flow out naming the definition's.
// shortcut: Set or Add Key Value Pair (948), Remove by Key (1298) and Set Custom Variable of a dictionary are typed by
// analogy with Query and Get (not seen in an editor save yet); integer keys only; a structure value goes only into the
// nodes above (no list length, no list item by index yet): upgrade from a creator's save that uses them.
const SPLIT_CALL=/^split:(.+)$/,MODIFY_CALL=/^modify:(.+)$/,SPLIT_READ=/^split:(.+):(\d+)$/;
const SET_CUSTOM_VARIABLE=22,DICT_QUERY=1158,LIST_LOOP=509,DICT_SET=948,DICT_REMOVE=1298;
// node id -> pin type the node is typed by -> {pins: [[pin kind, place, pin type, indexOfConcrete]], usingStruct numbers, affiliation type}
const STRUCT_TYPED={
  [GET_CUSTOM_VARIABLE]:{27:{pins:[[4,0,27,20]],typeXxx:74,one:2,aff:23},26:{pins:[[4,0,26,22]],typeXxx:175,one:1,aff:23}},
  [SET_CUSTOM_VARIABLE]:{27:{pins:[[3,2,27,20]],typeXxx:74,one:2,aff:27},26:{pins:[[3,2,26,22]],typeXxx:175,one:1,aff:27}},
  [DICT_QUERY]:{27:{pins:[[3,0,27,0],[4,0,25,10]],typeXxx:54,one:2,aff:320}},
  [LIST_LOOP]:{26:{pins:[[3,0,26,10],[4,0,25,10]],typeXxx:10,one:1,aff:8}},
  [DICT_SET]:{27:{pins:[[3,0,27,0],[3,2,25,10]],typeXxx:54,one:2,aff:320}},
  [DICT_REMOVE]:{27:{pins:[[3,0,27,0]],typeXxx:54,one:2,aff:320}}};
const pairOf=id=>({key:3,value:25,structId:id,keyClientType:'Entity_',valueClientType:'Entity_'});
const STRUCT_VALUES={
  27:id=>[{class:'MapBase',itemType:{classBase:'Server',type_server:{type:'Dictionary',kind:'Pair',items:pairOf(id)}},bMap:{}},{class:'MapBase',mapPair:pairOf(id)}],
  26:id=>[{class:'ArrayBase',itemType:{classBase:'Server',type_server:{type:'StructList',kind:'Struct',item:{structId:id}}},bArray:{}},{class:'ArrayBase'}],
  25:id=>[{class:'StructBase',itemType:{classBase:'Server',type_server:{type:'Struct',kind:'Struct',item:{structId:id}}},bStruct:{}},{class:'StructBase',item:{structId:id}}]};
const structPinValue=(type,id,index)=>{const [value,wrapper]=STRUCT_VALUES[type](id);return {class:'ConcreteBase',alreadySetVal:true,bConcreteValue:{...(index?{indexOfConcrete:index}:{}),value,structs:{class:1,inner:{wrapper}}}};};
const SAYS_TYPE={25:'a structure',26:'a list of structures',27:'a dictionary of structures'};
export function toStructValues(gilBytes,giaBytes){
  const {root:proto,rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const nodes=graph?.nodes??[],idOf=n=>Number(n.genericId?.nodeId);
  const called=n=>idOf(n)===300000?(n.pins??[]).filter(p=>p?.i1?.kind===5).map(p=>textOf(p.value)).find(Boolean)?.val??'':'';
  const sends=nodes.filter(n=>SPLIT_CALL.test(called(n))||MODIFY_CALL.test(called(n))).sort((a,b)=>a.nodeIndex-b.nodeIndex);
  const reads=nodes.filter(n=>idOf(n)===GET_CUSTOM_VARIABLE&&SPLIT_READ.test(valueName(n)));
  const named=nodes.filter(n=>(idOf(n)===GET_CUSTOM_VARIABLE||idOf(n)===SET_CUSTOM_VARIABLE)&&valueName(n)&&!valueName(n).includes(':'));
  const payload=gilBytes.subarray(20,-4),structs=inspectStructs(payload);
  const assembled=new Map(structs.filter(s=>s.assemble).map(s=>[s.assemble.definitionId,s]));
  const built=nodes.filter(n=>assembled.has(idOf(n)));
  if(!sends.length&&!reads.length&&!built.length&&!named.length)return giaBytes;
  const declared=named.length?structVariablesNamed(payload,named.map(valueName)):new Map(),held=named.filter(n=>declared.has(valueName(n)));
  if(!sends.length&&!reads.length&&!built.length&&!held.length)return giaBytes;
  const Pin=proto.lookupType('NodePin'),Info=proto.lookupType('GraphAffiliation.Info'),Affiliation=proto.lookupType('GraphAffiliation'),Wire=proto.lookupType('NodeConnection');
  // The structure values: 'node:output' -> {type, structId}; the inputs allowed to take one: 'node:input'.
  const values=new Map(),allowed=new Set(),at=(n,k)=>n+':'+k;
  const input=(n,place)=>(n.pins??[]).find(p=>p?.i1?.kind===3&&(p.i1.index||0)===place);
  const sourceOf=(n,place)=>{const w=input(n,place)?.connects?.[0];return w&&w.connect?.kind===4?values.get(at(w.id,w.connect.index||0)):undefined;};
  const what=n=>called(n)||valueName(n)||'node '+idOf(n);
  const expect=(n,place,type,structId,why)=>{
    const got=sourceOf(n,place);
    if(!got||got.type!==type||(structId&&got.structId!==structId))fail('STRUCT_VALUE_EXPECTED',why+' takes '+SAYS_TYPE[type]+(structId?' of '+structs.find(s=>s.id===structId)?.name:'')+(got?', and is given '+SAYS_TYPE[got.type]+' of '+structs.find(s=>s.id===got.structId)?.name:', and is given none (a variable that holds structures is declared first: scene_add_components variables of type structList or dict)')+'.',{node:what(n)});
    allowed.add(at(n.nodeIndex,place));
  };
  const affiliated=new Set();
  const retype=(n,spec,structId)=>{
    n.concreteId=null;
    for(const [kind,place,type,index] of spec.pins){
      const old=(n.pins??[]).find(p=>p?.i1?.kind===kind&&(p.i1.index||0)===place),o=old?Pin.toObject(old):{i1:{kind,index:place},i2:{kind,index:place}};
      o.type=type;o.value=structPinValue(type,structId,index);
      const made=Pin.fromObject(o);n.pins=old?n.pins.map(p=>p===old?made:p):[...(n.pins??[]),made];
    }
    const info={source:{class:10001,type:20000,kind:22000,id:idOf(n)},typeXxx:spec.typeXxx,alwaysOneXxxx:spec.one,...(spec.one===1?{structId:{structId}}:{})};
    n.usingStruct=[Info.fromObject(info)];
    const key=JSON.stringify(info);
    if(!affiliated.has(key)){affiliated.add(key);graph.affiliations=[...(graph.affiliations??[]),Affiliation.fromObject({info,type:{type:spec.aff}})];}
  };
  const structNamed=name=>{const s=structs.find(x=>x.name===name);if(!s?.split||!s?.modify)fail('STRUCT_NOT_FOUND','The save has no structure of this name: scene_add_struct makes one.',{struct:name,structs:structs.map(x=>x.name)});return s;};
  const asDefinition=(n,definitionId)=>{const id={class:10001,type:20000,kind:22001,nodeId:definitionId};n.genericId=id;n.concreteId={...id};};
  for(const n of built)values.set(at(n.nodeIndex,0),{type:25,structId:assembled.get(idOf(n)).id});
  // Variables that hold structures.
  for(const n of held){
    const v=declared.get(valueName(n));
    if(v.conflict)fail('STRUCT_VARIABLE_AMBIGUOUS','Two variables of this name hold different things in this save: give them different names.',{variable:valueName(n)});
    retype(n,STRUCT_TYPED[idOf(n)][v.type],v.structId);
    if(idOf(n)===GET_CUSTOM_VARIABLE)values.set(at(n.nodeIndex,0),{type:v.type,structId:v.structId});
  }
  // The dictionary and list nodes they feed, then the nodes those feed, until nothing changes.
  const generic=nodes.filter(n=>[DICT_QUERY,LIST_LOOP,DICT_SET,DICT_REMOVE].includes(idOf(n))),typed=new Map();
  for(let changed=true;changed;){
    changed=false;
    for(const n of generic){
      const got=!typed.has(n)&&sourceOf(n,0),spec=got&&STRUCT_TYPED[idOf(n)][got.type];
      if(!spec)continue;
      retype(n,spec,got.structId);typed.set(n,got.structId);allowed.add(at(n.nodeIndex,0));changed=true;
      if(idOf(n)===DICT_QUERY||idOf(n)===LIST_LOOP)values.set(at(n.nodeIndex,0),{type:25,structId:got.structId});
    }
  }
  for(const [n,structId] of typed)if(idOf(n)===DICT_SET)expect(n,2,25,structId,'The value of Set or Add Key Value Pair');
  for(const n of held)if(idOf(n)===SET_CUSTOM_VARIABLE){
    const v=declared.get(valueName(n));
    if(input(n,2)?.connects?.length)expect(n,2,v.type,v.structId,'Set Custom Variable of '+valueName(n));
  }
  // Split and Modify.
  const splits=[];
  for(const n of sends){
    const [,name]=SPLIT_CALL.exec(called(n))??MODIFY_CALL.exec(called(n)),split=SPLIT_CALL.test(called(n))&&!MODIFY_CALL.test(called(n)),s=structNamed(name);
    const ins=(n.pins??[]).filter(p=>p?.i1?.kind===3).sort((a,b)=>(a.i1.index||0)-(b.i1.index||0));
    expect(n,0,25,s.id,split?"f.sendSignal('split:"+name+"', <structure>)":"f.sendSignal('modify:"+name+"', <structure>, 'field', value, ...)");
    const structure=Pin.fromObject({i1:{kind:3},i2:{kind:3},type:25,connects:Pin.toObject(ins[0]).connects??[],compositePinIndex:(split?s.split:s.modify).pins[0]});
    if(split){
      if(ins.length!==1)fail('STRUCT_SPLIT',"A split takes the structure alone: f.sendSignal('split:"+name+"', <structure>); its fields are read after it with f.getCustomVariable(entity, 'split:"+name+":K').",{struct:name});
      flowPast(graph,n,Wire);asDefinition(n,s.split.definitionId);n.pins=[structure];splits.push({node:n,s});
      continue;
    }
    if(ins.length<3||ins.length%2===0)fail('STRUCT_MODIFY',"f.sendSignal('modify:"+name+"', <structure>, 'field', value, ...): the structure, then each field's name and its new value.",{struct:name});
    const set=[],seen=new Set();
    for(let i=1;i<ins.length;i+=2){
      const field=textOf(ins[i].value)?.val,k=s.fields.findIndex(f=>f.name===field);
      if(ins[i].connects?.length||k<0||seen.has(k))fail('STRUCT_MODIFY','A modify names each field once, written out: '+s.fields.map(f=>"'"+f.name+"'").join(', ')+'.',{struct:name,field:field??null});
      seen.add(k);
      if(ins[i+1].type!==STRUCT_FIELD_TYPES[s.fields[k].type][0])fail('STRUCT_MODIFY','The field '+s.fields[k].name+' of '+name+' takes a '+s.fields[k].type+'.',{struct:name,field});
      const o=Pin.toObject(ins[i+1]);o.i1={kind:3,index:2+2*k};o.i2={kind:3,index:1+2*k};o.compositePinIndex=s.modify.pins[2+2*k];
      if(o.value)o.value.itemType={...(o.value.itemType??{}),type_server:{...(o.value.itemType?.type_server??{}),type:o.type}};
      set.push(Pin.fromObject(o),Pin.fromObject({i1:{kind:3,index:3+2*k},i2:{kind:3,index:2+2*k},type:4,compositePinIndex:s.modify.pins[3+2*k],
        value:{class:'EnumBase',alreadySetVal:true,itemType:{classBase:'Server',type_server:{type:'Boolean'}},bEnum:{val:1}}}));
    }
    const flows=(n.pins??[]).filter(p=>p?.i1?.kind===2);for(const p of flows)p.compositePinIndex=s.modify.outflows[0];
    asDefinition(n,s.modify.definitionId);n.pins=[...flows,structure,...set];
  }
  // What a split gives: each read goes from the last split of its structure before it.
  for(const r of reads){
    const [,name,place]=SPLIT_READ.exec(valueName(r)),call=splits.filter(c=>c.s.name===name&&c.node.nodeIndex<r.nodeIndex).sort((a,b)=>b.node.nodeIndex-a.node.nodeIndex)[0];
    const field=call?.s.fields[Number(place)],made=(r.pins??[]).find(p=>p?.i1?.kind===4)?.type;
    if(!call)fail('STRUCT_OUTPUT',"A field of a structure is read after the split that gives it: write f.sendSignal('split:"+name+"', <structure>) first.",{read:valueName(r)});
    if(!field)fail('STRUCT_OUTPUT','The structure '+name+' has '+call.s.fields.length+' field(s), counted from 0: '+call.s.fields.map((f,i)=>i+' '+f.name).join(', ')+'.',{read:valueName(r)});
    if(made!==STRUCT_FIELD_TYPES[field.type][0])fail('STRUCT_OUTPUT','The field '+field.name+' is a '+field.type+": read it with .asType('"+{int:'int',float:'float',string:'str'}[field.type]+"').",{read:valueName(r)});
    rewire(graph,r,call.node,Number(place));
  }
  graph.nodes=nodes.filter(n=>!reads.includes(n));
  // A structure value goes nowhere else (a queue node takes one, toStructNodes).
  for(const n of graph.nodes)for(const pin of n.pins??[])for(const w of pin.connects??[]){
    if(w.connect?.kind!==4||!values.has(at(w.id,w.connect.index||0)))continue;
    if(pin.i1?.kind===3&&(allowed.has(at(n.nodeIndex,pin.i1.index||0))||(idOf(n)===QUEUE&&pin.i1.index===3)))continue;
    fail('STRUCT_VALUE_MISUSED','A structure, a list of structures or a dictionary of them goes only into Query Dictionary Value by Key, List Iteration Loop, Set or Add Key Value Pair, Remove by Key, Set Custom Variable of its variable, a split or a modify; it is given to '+what(n)+'.',{node:what(n)});
  }
  const out=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(out.length+20,0);header.writeUInt32BE(out.length,16);
  return Buffer.concat([header,out,giaBytes.subarray(-4)]);
}
// Titles a creator reads in the editor. The compiler drops comments and keeps no source line per node, but a handler is
// one event node, so a run of `// @title text` lines right above the line of .on('event', ...) or .onSignal(NAME, ...)
// becomes that event node's note (节点注释), stored as the editor stores one: {content}, no position (read from the
// official sample 定时器地形, graph "Door Lever"). A signal named by a constant (const S = 'NAME', or const S = defineSignal('NAME', ...)) is looked up in the source. Handlers of
// one event that the compiler kept apart get their titles in order; if it merged them, their titles join on one node.
const TITLE=/^\s*\/\/\s*@title\b\s?(.*)$/,HANDLER=/\.(on|onSignal)\(\s*(?:(['"`])([^'"`]+)\2|([A-Za-z_$][\w$]*))/,MONITOR_SIGNAL=300001;
export function withTitles(giaBytes,code){
  const lines=String(code??'').split('\n'),wanted=[];
  for(let i=0;i<lines.length;i++){
    if(!TITLE.test(lines[i]))continue;
    const text=[];while(i<lines.length&&TITLE.test(lines[i]))text.push(TITLE.exec(lines[i++])[1].trim());
    while(i<lines.length&&!lines[i].trim())i++;
    const m=HANDLER.exec(lines[i]??''),title=text.join('\n');
    if(!m)fail('TITLE_WITHOUT_HANDLER','A // @title line stands right above the line of the handler it names: .on(\'event\', ...) or .onSignal(NAME, ...).',{title,line:i+1});
    let name=m[3];
    if(!name){const c=new RegExp('\\b(?:const|let|var)\\s+'+m[4].replace(/\$/g,'\\$')+'\\s*=\\s*(?:defineSignal\\(\\s*)?([\'"`])([^\'"`]+)\\1').exec(code);
      if(!c)fail('TITLE_WITHOUT_HANDLER','The signal of a titled handler is a constant the source does not set to a name: const '+m[4]+' = \'NAME\' or defineSignal(\'NAME\', ...).',{title,line:i+1});name=c[2];}
    const ids=m[1]==='onSignal'?null:eventNodeIds(name);
    if(m[1]==='on'&&!ids)fail('TITLE_WITHOUT_HANDLER','The titled handler\'s event is not a server event the catalogue knows: titles go on server graphs.',{title,event:name,line:i+1});
    wanted.push({key:m[1]==='onSignal'?'signal '+name:'event '+name,ids,title});
  }
  if(!wanted.length)return giaBytes;
  const {rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const nodes=[...(graph?.nodes??[])].sort((a,b)=>a.nodeIndex-b.nodeIndex);
  for(const key of new Set(wanted.map(w=>w.key))){
    const titles=wanted.filter(w=>w.key===key),{ids}=titles[0];
    const found=nodes.filter(n=>ids?ids.has(Number(n.genericId?.nodeId))||ids.has(Number(n.concreteId?.nodeId)):Number(n.genericId?.nodeId)===MONITOR_SIGNAL&&'signal '+(n.pins??[]).filter(p=>p?.i1?.kind===5).map(p=>textOf(p.value)?.val).find(Boolean)===key);
    if(!found.length)fail('TITLE_WITHOUT_HANDLER','The compiled graph has no handler of this '+key.split(' ')[0]+' for the title to go on.',{title:titles[0].title,[key.split(' ')[0]]:key.slice(key.indexOf(' ')+1)});
    if(found.length===titles.length)titles.forEach((t,k)=>{found[k].comments={content:t.title};});
    else found[0].comments={content:titles.map(t=>t.title).join('\n')};
  }
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,giaBytes.subarray(-4)]);
}
function listedSignals(gilBytes){const payload=gilBytes.subarray(20,-4),found=[];parseMessage(payload,0,payload.length,0,0,0,0,0,0,0,found);return [...buildSignalNodeIdMapFromFields(payload,found).keys()];}
export function inject(bytes, giaBytes, targetId, replaceEditorGraph=false, code='') {
  // Keep upstream non-empty target checks enabled; never patch arbitrary binary fields.
  const result=createInjector({lang:'en-US'}).injectBytes({gilBytes:bytes,giaBytes:toEmptyEntities(toStructValues(bytes,toStructNodes(bytes,toCompositeNodes(bytes,toClientScriptSignals(bytes,withTitles(giaBytes,code)))))),targetId,skipNonEmptyCheck:replaceEditorGraph});
  inspectBytes(result.bytes);
  return Buffer.from(result.bytes);
}
