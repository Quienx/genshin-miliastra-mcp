// Offline check of scene_add_composite_node against two small saves that hold composite nodes a creator made by hand
// in the editor (生成复合节点; the fixtures are spliced from those saves, scripts/dev/composite_fixture.mjs):
// a definition written with the editor's own numbers is the editor's byte for byte, and a node made here of a graph
// has its definition, its inner graph and its place in the graph where a save keeps them. That the tool makes the
// very node the editor made of the same graph is checked on a creator's own saves, which are not in the repository
// (scripts/dev/composite_make_check.mjs: "Copy Slots" and "SSCountHeld", 2026-11-15).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {container,fields,replace,wrap} from '../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {addCompositeNode} from '../src/scene-save.mjs';
import {compositeDefinition} from '../src/scene/composite-make.mjs';
import {inspectCompositeNodes} from '../src/scene/composite-nodes.mjs';

const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures'),workspace=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-composite-'));
const {root,nodeGraphMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef'),opt={longs:String,enums:String};
const msgs=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const section=file=>fields(container(fs.readFileSync(file))).find(f=>f.id===10).data;
const records=(file,group)=>fields(section(file)).filter(f=>f.id===group&&f.wire===2).flatMap(f=>msgs(f.data,1));
const graphs=(file,group)=>records(file,group).flatMap(raw=>{try{return [nodeGraphMessage.toObject(nodeGraphMessage.decode(raw),opt)];}catch{return [];}});
try{
  for(const fixture of ['composite-node-spliced.gil','composite-output-spliced.gil']){
    const file=path.join(dir,fixture);let seen=0;
    for(const raw of records(file,2)){
      let def;try{def=Def.toObject(Def.decode(raw),opt);}catch{continue;}
      if(def.type?.kind!=='Composite')continue;
      const pin=p=>({name:p.name,pinIndex:p.pinIndex,type:p.type});seen++;
      assert.ok(compositeDefinition({definitionId:Number(def.id.genericId.id),graphId:Number(def.id.graphId.id),name:def.name,description:def.description,inflow:pin(def.inflows[0]),
        outflow:def.outflows?.[0]?pin(def.outflows[0]):null,inputs:(def.inputs??[]).map(pin),outputs:(def.outputs??[]).map(pin)}).equals(raw),'the definition of "'+def.name+'" differs from the editor\'s');
    }
    assert.ok(seen,'no composite node in '+fixture);
  }
  // A graph that is an event, one node that takes two values of it and gives one, and a print of that value (here
  // the node is itself a composite node, the one the creator made): the node becomes a new composite node "Wrapped".
  const file=path.join(dir,'composite-output-spliced.gil'),before=inspectCompositeNodes(container(fs.readFileSync(file)));
  const used=graphs(file,1).find(g=>g.nodes.length===4&&g.nodes.some(n=>n.genericId.nodeId===before.find(c=>c.outputs.length)?.definitionId));
  assert.ok(used,'the fixture has no graph of an event, a node and a print');
  const graphId=Number(used.id.id),made=addCompositeNode({mapPath:file,graphId,name:'Wrapped',outputName:'made'},workspace);
  const after=inspectCompositeNodes(container(fs.readFileSync(made.mapPath))),node=after.find(c=>c.name==='Wrapped');
  assert.equal(after.length,before.length+1);assert.equal(made.replaced,false);assert.equal(made.nodes,1);assert.equal(made.flowOut,true);
  assert.equal(node.definitionId,Math.max(...records(file,2).map(raw=>Number(Def.toObject(Def.decode(raw),opt).id?.genericId?.id??0)))+1,'the id is not the one after the highest');
  assert.equal(node.graphId,Math.max(...before.map(c=>c.graphId))+1);
  assert.deepEqual([node.inflows.length,node.outflows.length,node.inputs.map(p=>p.type.type1),node.outputs.map(p=>p.type.type1)],[1,1,['Entity','String'],['Integer']]);
  const numbers=[...node.inflows,...node.outflows,...node.inputs,...node.outputs].map(p=>p.pinIndex),taken=records(file,2).flatMap(raw=>fields(raw).filter(f=>f.wire===2&&f.id>=100&&f.id<=106).map(f=>Number(fields(f.data).find(x=>x.id===8)?.value??0)));
  assert.equal(new Set(numbers).size,numbers.length);assert.ok(Math.min(...numbers)>Math.max(...taken),'a pin number of the save is used again');
  const inner=graphs(made.mapPath,4).find(g=>g.id.id===String(node.graphId)),was=used.nodes.find(n=>n.nodeIndex===made.nodeIndex);
  assert.equal(inner.id.kind,'CompositeGraph');assert.deepEqual(inner.nodes.map(n=>[n.nodeIndex,n.genericId.nodeId]),[[was.nodeIndex,was.genericId.nodeId]]);
  assert.ok(inner.nodes[0].pins.every(p=>!(p.connects??[]).length),'a wire still leaves the inner graph');
  assert.deepEqual(inner.compositePins.map(p=>[p.outerPin.kind,p.outerPin.index??0,p.innerNodeId,p.innerPin.kind,p.innerPin.index??0].join(' ')),
    ['InFlow 0 N InFlow 0','OutFlow 0 N OutFlow 0','InParam 0 N InParam 0','InParam 1 N InParam 1','OutParam 0 N OutParam 0'].map(s=>s.replace('N',was.nodeIndex)));
  const now=graphs(made.mapPath,1).find(g=>g.id.id===used.id.id),placed=now.nodes.find(n=>n.genericId.nodeId===node.definitionId);
  assert.equal(now.nodes.length,4);
  assert.deepEqual(placed.pins.map(p=>[p.i1.kind,p.i1.index??0,p.compositePinIndex].join(' ')).sort(),[['OutFlow',0,node.outflows[0].pinIndex],['InParam',0,node.inputs[0].pinIndex],['InParam',1,node.inputs[1].pinIndex]].map(p=>p.join(' ')).sort());
  const count=(f,group)=>fields(section(f)).filter(x=>x.id===group).length;       // (the fixture's section is spliced: its groups are not in a save's order)
  assert.deepEqual([1,2,4].map(g=>count(made.mapPath,g)-count(file,g)),[0,1,1]);
  // Made again of the graph as it was, it is replaced in place: the same definition, nothing more in the section.
  const bytes=fs.readFileSync(made.mapPath),payload=container(bytes),own=s=>fields(s).filter(f=>f.id===1&&f.wire===2).find(f=>{try{return String(nodeGraphMessage.decode(msgs(f.data,1)[0]).id.id)===used.id.id;}catch{return false;}});
  const body=path.join(workspace,'body.gil');
  fs.writeFileSync(body,wrap(bytes,replace(payload,10,2,Buffer.concat(fields(section(made.mapPath)).map(f=>f.raw.equals(own(section(made.mapPath)).raw)?own(section(file)).raw:f.raw)))));
  const again=addCompositeNode({mapPath:body,graphId,name:'Wrapped',outputName:'again'},workspace);
  assert.equal(again.replaced,true);assert.ok(fs.readFileSync(again.mapPath).equals(bytes),'made again, the save is another');
  // What cannot be a node is refused, and says why.
  assert.throws(()=>addCompositeNode({mapPath:file,graphId:1,name:'X'},workspace),e=>e.code==='GRAPH_NOT_FOUND');
  assert.throws(()=>addCompositeNode({mapPath:file,graphId,name:'X',outside:used.nodes.map(n=>n.nodeIndex)},workspace),e=>e.code==='COMPOSITE_GRAPH_SHAPE');
  console.log('scene_add_composite_node: definitions match the editor\'s, a node is made and made again in place');
}finally{fs.rmSync(workspace,{recursive:true,force:true});}
