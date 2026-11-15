// node scripts/dev/composite_make_check.mjs <before.gil> <after.gil> <graphId> <name>: makes the composite node of
// <graphId> in <before> and holds it against what the editor wrote in <after>, where a creator made the same node by
// hand (生成复合节点). For a creator's own saves, which are not in the repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {container,fields,replace,wrap} from '../../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {addCompositeNode} from '../../src/scene-save.mjs';
import {compositeDefinition} from '../../src/scene/composite-make.mjs';
import {inspectCompositeNodes} from '../../src/scene/composite-nodes.mjs';
const [before,after,graphArg,name]=process.argv.slice(2),graphId=Number(graphArg);
const {root,nodeGraphMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef'),opt={longs:String,enums:String};
const msgs=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const read=file=>{const payload=container(fs.readFileSync(file)),groups=msgs(payload,10).flatMap(s=>fields(s).filter(f=>f.wire===2));
  const graphs=id=>groups.filter(g=>g.id===id).flatMap(g=>msgs(g.data,1)).flatMap(raw=>{try{return [{raw,graph:nodeGraphMessage.toObject(nodeGraphMessage.decode(raw),opt)}];}catch{return [];}});
  const defs=groups.filter(g=>g.id===2).flatMap(g=>msgs(g.data,1)).flatMap(raw=>{try{const def=Def.toObject(Def.decode(raw),opt);return def.type?.kind==='Composite'?[{raw,def}]:[];}catch{return [];}});
  const def=defs.find(d=>d.def.name===name),inner=graphs(4).find(g=>g.graph.id.id===def?.def.id.graphId.id)?.graph;
  return {payload,defs,def,inner,graph:graphs(1).find(g=>g.graph.id.id===String(graphId))?.graph,order:fields(msgs(payload,10)[0]).map(f=>f.id).join(',').replace(/(\d+)(,\1)+/g,(m,a)=>a+'x'+m.split(',').length)};};
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-composite-'));
try{
  const theirs=read(after);
  // 1. A definition written with the editor's own numbers and names is the editor's, byte for byte.
  for(const {raw,def} of theirs.defs){
    const pin=p=>({name:p.name,pinIndex:p.pinIndex,type:p.type});
    assert.ok(compositeDefinition({definitionId:Number(def.id.genericId.id),graphId:Number(def.id.graphId.id),name:def.name,description:def.description,inflow:pin(def.inflows[0]),outflow:def.outflows?.[0]?pin(def.outflows[0]):null,
      inputs:(def.inputs??[]).map(pin),outputs:(def.outputs??[]).map(pin)}).equals(raw),'the definition of "'+def.name+'" differs from the editor\'s');
  }
  // 2. The node made here of the graph as it was before.
  const made=addCompositeNode({mapPath:before,graphId,name,outputName:'made'},workspace),mine=read(made.mapPath);
  console.log('made:',JSON.stringify({...made,next:undefined}));
  assert.deepEqual(mine.inner.compositePins,theirs.inner.compositePins,'the inner pins differ');
  assert.deepEqual(mine.inner.nodes.map(n=>n.nodeIndex),theirs.inner.nodes.map(n=>n.nodeIndex),'other nodes went inside');
  assert.deepEqual(mine.inner.id,{...theirs.inner.id,id:mine.inner.id.id});
  // the inner nodes: what each is and what it is wired to (the editor also drops pins that hold nothing, which is not followed)
  const wires=g=>g.nodes.map(n=>[n.nodeIndex,n.genericId.nodeId,n.concreteId.nodeId,(n.pins??[]).flatMap(p=>(p.connects??[]).map(c=>[p.i1.kind,p.i1.index??0,c.id,c.connect.kind,c.connect.index??0].join(' '))).sort()]);
  assert.deepEqual(wires(mine.inner),wires(theirs.inner),'the inner graph is wired otherwise');
  // the definition, but for its numbers and the names the editor takes from the inner pins
  const shape=d=>({id:{...d.id,genericId:{...d.id.genericId,id:0},concreteId:{...d.id.concreteId,id:0},graphId:{...d.id.graphId,id:0}},type:d.type,xxx:d.xxx,name:d.name,
    pins:['inflows','outflows','inputs','outputs'].map(k=>(d[k]??[]).map(p=>({visible:p.visible,index:p.index,type:p.type,description:p.description})))});
  assert.deepEqual(shape(mine.def.def),shape(theirs.def.def),'the definition differs');
  const numbers=d=>['inflows','outflows','inputs','outputs'].flatMap(k=>(d[k]??[]).map(p=>p.pinIndex));
  assert.equal(new Set(numbers(mine.def.def)).size,numbers(mine.def.def).length);
  // the graph: the same nodes are left, and the node in their place is wired as the editor's, each pin naming its pin of the definition
  const node=g=>g.nodes.find(n=>n.genericId.nodeId===Number(readDef(g).def.id.genericId.id)),readDef=g=>g===mine.graph?mine.def:theirs.def;
  const pins=(g,n)=>n.pins.map(p=>[p.i1.kind,p.i1.index??0,p.type??0,Object.entries({inflows:0,outflows:0,inputs:0,outputs:0}).flatMap(([k])=>(readDef(g).def[k]??[]).map((d,i)=>d.pinIndex===p.compositePinIndex?k+i:null)).find(Boolean),(p.connects??[]).map(c=>[c.id,c.connect.kind,c.connect.index??0].join(' ')).join('|')].join(' ')).sort();
  assert.deepEqual(pins(mine.graph,node(mine.graph)),pins(theirs.graph,node(theirs.graph)),'the node in the graph is wired otherwise');
  const rest=g=>wires({nodes:g.nodes.filter(n=>n!==node(g))}).map(r=>JSON.stringify(r).replaceAll(' '+node(g).nodeIndex+' ',' N '));
  assert.deepEqual(rest(mine.graph),rest(theirs.graph),'what stayed outside is wired otherwise');
  assert.equal(mine.order,theirs.order,'the section is laid out otherwise');
  assert.deepEqual(inspectCompositeNodes(mine.payload).map(c=>c.name),inspectCompositeNodes(theirs.payload).map(c=>c.name));
  // 3. Made again of the body as it was (which is what writing the graph's source again leaves), the node is replaced
  // in place: the same ids and pin numbers, nothing added to the section.
  const raws=file=>{const bytes=fs.readFileSync(file),payload=container(bytes);return {bytes,payload,section:fields(payload).find(f=>f.id===10).data};};
  const was=raws(before),now=raws(made.mapPath),own=section=>fields(section).filter(f=>f.id===1&&f.wire===2).find(f=>{try{return String(nodeGraphMessage.decode(msgs(f.data,1)[0]).id.id)===String(graphId);}catch{return false;}});
  const body=path.join(workspace,'body.gil');
  fs.writeFileSync(body,wrap(now.bytes,replace(now.payload,10,2,Buffer.concat(fields(now.section).map(f=>f.raw.equals(own(now.section).raw)?own(was.section).raw:f.raw)))));
  const again=addCompositeNode({mapPath:body,graphId,name,outputName:'again'},workspace),second=read(again.mapPath);
  assert.equal(again.replaced,true);
  assert.ok(second.def.raw.equals(mine.def.raw),'made again, the definition changed');
  assert.deepEqual(second.inner,mine.inner);assert.deepEqual(second.graph,mine.graph);assert.equal(second.order,mine.order);
  assert.equal(fs.statSync(again.mapPath).size,fs.statSync(made.mapPath).size);
  console.log('order:',mine.order,'| ids',mine.def.def.id.genericId.id,'vs editor',theirs.def.def.id.genericId.id,'| inner',mine.inner.id.id,'vs',theirs.inner.id.id,'| pins',numbers(mine.def.def).join(' '),'vs',numbers(theirs.def.def).join(' '));
  console.log('ok');
}finally{fs.rmSync(workspace,{recursive:true,force:true});}
