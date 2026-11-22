import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseMessage} from 'genshin-ts/injector/binary';
import {buildNodeGraphFieldIndex} from 'genshin-ts/injector/node_graph';
import {buildSignalNodeIdMapFromFields} from 'genshin-ts/injector/signal_nodes';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {SPECIAL_NODE_IDS} from 'genshin-ts/compiler/ir_to_gia_transform/mappings';
import {inspectCompositeNodes} from './composite-nodes.mjs';
import {inspectStructs} from './struct-make.mjs';

// Reads a node graph of a save the way the editor shows it: every node with its name and every pin with its name and
// the value written in it, or the node and output it is wired from. For graphs made in the editor (a skill's client
// graph, a creator's server graph), which write_graphs cannot open. Names come from the pinned genshin-ts catalogues:
// the node lists (client and server), the parameter names of the methods that write each node, and the enum values.
const pkg=path.dirname(fileURLToPath(import.meta.resolve('genshin-ts/package.json')));
const DATA=path.join(pkg,'dist/src/thirdparty/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack/node_data');
const load=f=>import(pathToFileURL(path.join(DATA,f)).href);
const [{CLIENT_NODE_METADATA},{NODE_PIN_RECORDS},{NODE_ID},{ENUM_VALUE},{CLIENT_ENUM_VALUES}]=await Promise.all(
  ['client_node_metadata.js','node_pin_records.js','node_id.js','enum_id.js','client_enum_values.js'].map(load));

// The parameter names of each node, in the order of its data inputs, from the generated method that writes it.
function argNames(file){
  const text=fs.readFileSync(path.join(pkg,'dist/src/definitions',file),'utf8'),names=new Map();
  for(const [,type,args] of text.matchAll(/nodeType: '(\w+)',\s*args: \[([^\]]*)\]/g))
    if(!names.has(type))names.set(type,args.split(',').map(a=>a.trim().replace(/Obj$/,'')).filter(Boolean));
  return names;
}
const SERVER_ARGS=argNames('nodes.js'),CLIENT_ARGS=argNames('client_nodes.js');
const title=s=>s.replace(/^_/,'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const words=s=>s.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());

const CLIENT=new Map();
for(const m of CLIENT_NODE_METADATA){CLIENT.set(m.genericId+'/'+m.concreteId,m);if(!CLIENT.has(String(m.genericId)))CLIENT.set(String(m.genericId),m);}
const SERVER_RECORD=new Map(NODE_PIN_RECORDS.map(r=>[r.id,r]));
const SERVER_TYPE=new Map();
for(const [key,id] of Object.entries(NODE_ID))if(!SERVER_TYPE.has(id))SERVER_TYPE.set(id,key.replace(/__.*$/,'').toLowerCase());
for(const [type,id] of Object.entries(SPECIAL_NODE_IDS))SERVER_TYPE.set(id,type);
// The ids an event's node can have, by the name a graph's source gives the event ('whenEntityIsCreated' -> 71, written
// When_Entity_Is_Created in the catalogue; 'whenTheCharacterIsDown' -> When_the_Character_Is_Down); a generic event
// (whenCustomVariableChanges) has one id per type.
const eventKey=s=>s.replace(/__.*$/,'').replace(/[^A-Za-z0-9]/g,'').toLowerCase(),EVENT_IDS=new Map();
for(const [key,id] of Object.entries(NODE_ID)){const k=eventKey(key);if(!EVENT_IDS.has(k))EVENT_IDS.set(k,new Set());EVENT_IDS.get(k).add(id);}
export const eventNodeIds=name=>EVENT_IDS.get(eventKey(name));
// An enum value is one number across all enums (2902 is only "rotation type: target orientation").
const ENUM=new Map();
for(const [name,v] of Object.entries(CLIENT_ENUM_VALUES))if(typeof v==='number')ENUM.set(v,name);
for(const [name,v] of Object.entries(ENUM_VALUE))ENUM.set(v,name);

function value(v){
  if(!v)return undefined;
  if(v.bConcreteValue)return value(v.bConcreteValue.value);
  if(v.bArray)return (v.bArray.entries??[]).map(value);
  if(v.bMap)return (v.bMap.mapPairs??[]).map(p=>[value(p.bMapPair?.key),value(p.bMapPair?.value)]);
  if(v.bStruct)return (v.bStruct.items??[]).map(value);
  if(v.bVector){const {x=0,y=0,z=0}=v.bVector.val??{};return [x,y,z];}
  if(v.bEnum){const n=Number(v.bEnum.val??0);return n&&ENUM.has(n)?ENUM.get(n)+' ('+n+')':n;}
  if(v.bString)return v.bString.val??'';
  for(const k of ['bId','bInt','bFloat'])if(v[k])return Number(v[k].val??0);
  return undefined;
}
// A pin that carries a structure names it: "Struct ItemInstance", "StructList ItemInstance", "Dictionary<Integer, ItemInstance>".
const typeOf=(w,structs)=>{const v=w?.bConcreteValue?.value??w,server=v?.itemType?.type_server,t=v?.itemType?.type_client?.type??server?.type;
  const named=id=>structs?.get(Number(id))??'structure '+id;
  if((t==='Struct'||t==='StructList')&&server?.item?.structId)return t+' '+named(server.item.structId);
  if(t==='Dictionary'&&Number(server?.items?.value)===25)return 'Dictionary<'+({3:'Integer',6:'String'}[server.items.key]??server.items.key)+', '+named(server.items.structId)+'>';
  return typeof t==='string'?t.replace(/_$/,''):t;};
const kindOf=i=>i?.kind??'InFlow';

// Nodes of one graph. signalNames: generic node id -> 'send signal NAME' and the like; composite: id -> name;
// shapes: {structs: id -> name, nodes: definition id -> {node, pins (input names by place), outs}} of the save's structures.
function readNodes(graph,client,signalNames,composite,shapes={structs:new Map(),nodes:new Map()}){
  return (graph.nodes??[]).map(node=>{
    const gid=Number(node.genericId?.nodeId??0),cid=Number(node.concreteId?.nodeId??0),out={n:node.nodeIndex};
    let names=[],argPins=null,raw=false;
    if(client){
      const m=CLIENT.get(gid+'/'+cid)??CLIENT.get(String(gid));
      if(m){out.node=title(m.nodeType);out.zh=m.displayName;names=CLIENT_ARGS.get(m.nodeType)??[];argPins=m.argPins??null;}
    }else if(composite.has(gid))out.node='composite: '+composite.get(gid);
    else if(shapes.nodes.has(gid)){const d=shapes.nodes.get(gid);out.node=d.node;names=d.pins;raw=true;if(d.outs)out.out=Object.fromEntries(d.outs.map((n,i)=>['out'+i,n]));}
    else if(signalNames.has(gid))out.node=signalNames.get(gid);
    else{const type=SERVER_TYPE.get(gid);out.node=SERVER_RECORD.get(gid)?.name??(type?title(type):undefined);names=SERVER_ARGS.get(type)??[];}
    out.node??='unknown';out.id=cid&&cid!==gid?gid+'/'+cid:gid;
    if(node.comments?.content)out.comment=node.comments.content;
    const pinName=i=>{const k=argPins?argPins.indexOf(i):i,n=names[k];return n?(raw?n:words(n)):'in'+i;};
    const inputs={},outputs={},next={};
    for(const p of node.pins??[]){
      const kind=kindOf(p.i1),i=Number(p.i1?.index??0),wires=p.connects??[];
      if(kind==='OutFlow'){if(wires.length)next[i]=wires.map(c=>c.id);continue;}
      if(kind==='InFlow')continue;
      if(kind==='OutParam'){outputs['out'+i]=typeOf(p.value,shapes.structs);continue;}
      if(kind!=='InParam'){const v=value(p.value);if(v!==undefined&&v!==0&&v!=='')inputs.signal=v;continue;}
      const name=pinName(i);
      inputs[name]=wires.length?'<- #'+wires.map(c=>c.id+(c.connect?.index?'.out'+c.connect.index:'')).join(', #'):value(p.value)??null;
    }
    if(Object.keys(inputs).length)out.in=inputs;
    if(Object.keys(outputs).length)out.out={...out.out,...outputs};
    if(Object.keys(next).length)out.next=Object.keys(next).length===1&&next[0]?next[0]:next;
    return out;
  });
}

// The graph of a save by id or by name, read.
export function readGraph(bytes,{graphId,name}={}){
  const payload=bytes.subarray(20,-4),fields=[];
  parseMessage(payload,0,payload.length,0,0,0,0,0,0,0,fields);
  const {nodeGraphMessage}=loadGiaProto(),found=[];
  for(const [id,matches] of buildNodeGraphFieldIndex(payload,fields))for(const m of matches){
    if(graphId!==undefined&&Number(id)!==Number(graphId))continue;
    const graph=nodeGraphMessage.toObject(nodeGraphMessage.decode(payload.subarray(m.field.dataStart,m.field.dataEnd)),{defaults:false,longs:String,enums:String});
    if(name!==undefined&&graph.name!==name)continue;
    found.push({id:Number(id),type:m.type,graph});
  }
  if(!found.length)throw Object.assign(new Error('The save has no graph with this '+(graphId!==undefined?'id':'name')+': inspect_map lists them.'),{code:'GRAPH_NOT_FOUND',details:{graphId,name}});
  const signalNames=new Map();
  for(const [signal,ids] of buildSignalNodeIdMapFromFields(payload,fields))for(const [role,t] of Object.entries(ids))signalNames.set(Number(t.nodeId),role+' '+signal);
  const composite=new Map(inspectCompositeNodes(payload).map(c=>[c.definitionId,c.name]));
  const structs=inspectStructs(payload),shapes={structs:new Map(structs.map(s=>[s.id,s.name])),nodes:new Map()};
  for(const s of structs){
    if(s.assemble)shapes.nodes.set(s.assemble.definitionId,{node:'Assemble Structure '+s.name,pins:s.fields.map(f=>f.name)});
    if(s.split)shapes.nodes.set(s.split.definitionId,{node:'Split Structure '+s.name,pins:[s.name],outs:s.fields.map(f=>f.name)});
    if(s.modify)shapes.nodes.set(s.modify.definitionId,{node:'Modify Structure '+s.name,pins:[s.name,'Modify Object',...s.fields.flatMap(f=>[f.name,'set '+f.name])]});
  }
  return {graphs:found.map(({id,type,graph})=>{
    const client=Number(type)!==20000;
    return {id,name:graph.name??'',type,side:client?'client':'server',nodeCount:graph.nodes?.length??0,
      nodes:readNodes(graph,client,signalNames,composite,shapes)};
  }),
  reading:'n is the node\'s number in the graph; comment: the note shown over the node in the editor; in: each input by name, its value, or "<- #k" when wired from node k (".outJ" its output J); next: the nodes the flow goes on to (by output: 0 true / 1 false for a branch); enum values by name and number; vectors as [x,y,z]; lists as arrays. Names are those of the catalogue the compiler uses and may differ from the editor\'s words.'};
}
