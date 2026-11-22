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
import {inspectStructs} from './scene/struct-make.mjs';
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
// shortcut: a structure only goes into a queue node, the one written next after it; upgrade when a graph needs one elsewhere.
const STRUCT_CALL=/^struct:/,QUEUE=833;
export function toStructNodes(gilBytes,giaBytes){
  const {root:proto,rootMessage}=loadGiaProto(),root=rootMessage.decode(giaBytes.subarray(20,giaBytes.length-4)),graph=root?.graph?.graph?.inner?.graph;
  const named=(graph?.nodes??[]).filter(n=>n.genericId?.nodeId===300000).map(n=>({node:n,text:(n.pins??[]).filter(p=>p?.i1?.kind===5).map(p=>textOf(p.value)).find(Boolean)})).filter(x=>x.text&&STRUCT_CALL.test(x.text.val));
  if(!named.length)return giaBytes;
  const known=inspectStructs(gilBytes.subarray(20,-4)),Pin=proto.lookupType('NodePin'),Info=proto.lookupType('GraphAffiliation.Info'),Affiliation=proto.lookupType('GraphAffiliation'),Wire=proto.lookupType('NodeConnection');
  const queues=graph.nodes.filter(n=>n.genericId?.nodeId===QUEUE),taken=new Set(),used=new Set();
  for(const {node,text} of named.sort((a,b)=>a.node.nodeIndex-b.node.nodeIndex)){
    const name=text.val.replace(STRUCT_CALL,''),s=known.find(x=>x.name===name);
    if(!s?.assemble)fail('STRUCT_NOT_FOUND','The save has no structure of this name: scene_add_struct makes one.',{struct:name,structs:known.map(x=>x.name)});
    const inputs=(node.pins??[]).filter(p=>p?.i1?.kind===3).sort((a,b)=>(a.i1.index||0)-(b.i1.index||0));
    if(inputs.length!==s.fields.length)fail('STRUCT_FIELDS','The call gives '+inputs.length+' value(s) and the structure has '+s.fields.length+": f.sendSignal('struct:"+name+"'"+s.fields.map(f=>', <'+f.name+'>').join('')+').',{struct:name,fields:s.fields});
    const queue=queues.find(q=>q.nodeIndex>node.nodeIndex&&!taken.has(q));
    if(!queue)fail('STRUCT_UNUSED',"A structure built with f.sendSignal('struct:"+name+"', ...) goes into the f.refreshNotificationQueue(player, queue, item) written after it, and there is none.",{struct:name});
    taken.add(queue);
    // The flow goes past the node: what flowed into it flows where it went.
    const onward=(node.pins??[]).filter(p=>p?.i1?.kind===2).flatMap(p=>p.connects??[]);
    for(const other of graph.nodes)for(const pin of other.pins??[])if(pin?.i1?.kind===2&&(pin.connects??[]).some(w=>w.id===node.nodeIndex))
      pin.connects=pin.connects.flatMap(w=>w.id===node.nodeIndex?onward.map(o=>Wire.fromObject(Wire.toObject(o))):[w]);
    const id={class:10001,type:20000,kind:22001,nodeId:s.assemble.definitionId};
    node.genericId=id;node.concreteId={...id};
    // Each input as the editor writes one on an Assemble node: its field's type on the pin's value too (type_server),
    // without which the editor drops a wire into it and shows the field empty (seen 2026-11-17, a wire from a signal).
    node.pins=inputs.map((p,i)=>{const o=Pin.toObject(p);o.compositePinIndex=s.assemble.pins[i];if(o.value)o.value.itemType={...(o.value.itemType??{}),type_server:{...(o.value.itemType?.type_server??{}),type:o.type}};return Pin.fromObject(o);});
    const info={source:{class:10001,type:20000,kind:22000,id:QUEUE},alwaysOneXxxx:1,structId:{structId:s.id}};
    queue.pins=[...(queue.pins??[]).filter(p=>!(p?.i1?.kind===3&&p.i1.index===3)),Pin.fromObject({i1:{kind:3,index:3},i2:{kind:3,index:3},type:25,connects:[{id:node.nodeIndex,connect:{kind:4},connect2:{kind:4}}],
      value:{class:10000,alreadySetVal:true,bConcreteValue:{value:{class:10001,itemType:{classBase:1,type_server:{type:25,kind:1,item:{structId:s.id}}},bStruct:{}},structs:{class:1,inner:{wrapper:{class:10001,item:{structId:s.id}}}}}}})];
    queue.usingStruct=[Info.fromObject(info)];
    if(!used.has(s.id)){used.add(s.id);graph.affiliations=[...(graph.affiliations??[]),Affiliation.fromObject({info,type:{type:66002}})];}
  }
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(giaBytes.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,giaBytes.subarray(-4)]);
}
// Titles a creator reads in the editor. The compiler drops comments and keeps no source line per node, but a handler is
// one event node, so a run of `// @title text` lines right above the line of .on('event', ...) or .onSignal(NAME, ...)
// becomes that event node's note (节点注释), stored as the editor stores one: {content}, no position (read from the
// official sample 定时器地形, graph "Door Lever"). A signal named by a constant is looked up in the source. Handlers of
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
    if(!name){const c=new RegExp('\\b(?:const|let|var)\\s+'+m[4].replace(/\$/g,'\\$')+'\\s*=\\s*([\'"`])([^\'"`]+)\\1').exec(code);
      if(!c)fail('TITLE_WITHOUT_HANDLER','The signal of a titled handler is a constant the source does not set to a name: const '+m[4]+' = \'NAME\'.',{title,line:i+1});name=c[2];}
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
  const result=createInjector({lang:'en-US'}).injectBytes({gilBytes:bytes,giaBytes:toEmptyEntities(toStructNodes(bytes,toCompositeNodes(bytes,toClientScriptSignals(bytes,withTitles(giaBytes,code))))),targetId,skipNonEmptyCheck:replaceEditorGraph});
  inspectBytes(result.bytes);
  return Buffer.from(result.bytes);
}
