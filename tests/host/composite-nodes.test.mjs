import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectBytes,toCompositeNodes,inject} from '../../src/adapter.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {loadGiaGraph} from 'genshin-ts/injector/node_graph';

const fixture=name=>fs.readFileSync(new URL('../fixtures/'+name,import.meta.url));

// composite-node-spliced.gil: a graph of 73 nodes whose last 71 a creator wrapped into a composite node "Copy Slots"
// in the editor (scripts/dev/composite_fixture.mjs put its records into a small save).
test('a composite node made in the editor is listed with its pins, its inner graph and the graph that uses it',()=>{
  const save=inspectBytes(fixture('composite-node-spliced.gil'));
  assert.equal(save.compositeNodes.length,1);
  const [node]=save.compositeNodes;
  assert.deepEqual({name:node.name,description:node.description,inflows:node.inflows.length,outflows:node.outflows.length,inputs:node.inputs.map(p=>p.name),outputs:node.outputs},
    {name:'Copy Slots',description:'SS_CustomNode',inflows:1,outflows:1,inputs:['Character Entity'],outputs:[]});
  assert.deepEqual(node.inputs[0].type,{type1:'Entity',type2:'Entity'});
  assert.ok(node.definitionId>0&&node.graphId>0&&node.definitionId!==node.graphId);
  // The wrapped nodes are in the node's own graph, which is no graph of the save's list ...
  assert.deepEqual(node.graph,{nodeCount:72,editorCount:72,exposedPins:3});
  assert.ok(!save.graphs.some(g=>g.id===node.graphId));
  // ... and the graph that uses the node counts it as one node: the event and the composite node.
  assert.deepEqual(node.usedBy.map(u=>[u.graphName,u.nodeIndex]),[['_GSTS_SsCopySlots',5]]);
  const user=save.graphs.find(g=>g.id===node.usedBy[0].graphId);
  assert.equal(user.nodeCount,2);
  assert.equal(user.editorCount,2);
  assert.deepEqual(user.compositeNodeRefs,[{nodeIndex:5,definitionId:node.definitionId,name:'Copy Slots'}]);
  // A graph that uses none says nothing of them.
  assert.ok(save.graphs.filter(g=>g.id!==user.id).every(g=>!('compositeNodeRefs' in g)));
});

test('a save without composite nodes lists none: a signal\'s own node definitions are not composite nodes',()=>{
  const save=inspectBytes(fixture('editor-2026-10-13-signal4.gil'));
  assert.ok(save.signals.length>0);
  assert.deepEqual(save.compositeNodes,[]);
  assert.ok(save.graphs.every(g=>!('compositeNodeRefs' in g)));
});

// composite-call.gia: what the compiler makes of a graph that calls the node by name, as a send of 'composite:NAME':
//   .on('whenEntityIsCreated',(evt,f)=>{ f.printString('before'); f.sendSignal('composite:Copy Slots',evt.eventSourceEntity); f.printString('after'); })
// (The graph's id is that of the fixture's graph, which it is written in place of.)
const graphOf=gia=>{const proto=loadGiaProto();return proto.nodeGraphMessage.toObject(loadGiaGraph(gia,proto.rootMessage,proto.nodeGraphMessage),{longs:String,enums:String});};
// The same compiled graph with its nodes changed by `change` before it is written.
function changed(gia,change){
  const {rootMessage}=loadGiaProto(),root=rootMessage.decode(gia.subarray(20,gia.length-4));
  change(root.graph.graph.inner.graph);
  const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(gia.subarray(0,20));
  header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
  return Buffer.concat([header,payload,gia.subarray(-4)]);
}
const refused=(code,run)=>assert.throws(run,error=>error.code===code);

test('a send named composite:NAME becomes a call to that composite node of the save',()=>{
  const save=fixture('composite-node-spliced.gil'),[def]=inspectBytes(save).compositeNodes;
  const before=graphOf(fixture('composite-call.gia')).nodes.find(n=>n.genericId.nodeId===300000);
  assert.ok(before.pins.some(p=>p.i1.kind==='ClientExecNode'&&p.value.bString.val==='composite:Copy Slots'));
  const graph=graphOf(toCompositeNodes(save,fixture('composite-call.gia')));
  assert.equal(graph.nodes.length,4);
  assert.ok(!graph.nodes.some(n=>n.genericId.nodeId===300000),'no send is left');
  const node=graph.nodes.find(n=>Number(n.genericId.nodeId)===def.definitionId);
  // As the editor writes a composite node: the definition's id, no pin for a name, and every pin naming its pin of the definition.
  assert.deepEqual([node.genericId,node.concreteId],[{class:'SystemDefined',type:'Server',kind:'SysGraph',nodeId:def.definitionId},{class:'SystemDefined',type:'Server',kind:'SysGraph',nodeId:def.definitionId}]);
  assert.deepEqual(node.pins.map(p=>[p.i1.kind,p.compositePinIndex,p.connects.map(c=>c.id)]),[['InParam',def.inputs[0].pinIndex,[1]],['OutFlow',def.outflows[0].pinIndex,[4]]]);
  // The node before it still leads into it, and it leads on to the one after.
  assert.deepEqual(graph.nodes.find(n=>n.nodeIndex===2).pins.find(p=>p.i1.kind==='OutFlow').connects.map(c=>c.id),[node.nodeIndex]);
});

test('written into the save, the graph counts the call as one node and the composite node says who uses it',()=>{
  const written=inspectBytes(inject(fixture('composite-node-spliced.gil'),fixture('composite-call.gia'),1073741852));
  const graph=written.graphs.find(g=>g.id===1073741852),[def]=written.compositeNodes;
  assert.equal(graph.nodeCount,4);
  assert.equal(graph.editorCount,4);
  assert.deepEqual(graph.compositeNodeRefs,[{nodeIndex:3,definitionId:def.definitionId,name:'Copy Slots'}]);
  assert.deepEqual(def.usedBy,[{graphId:1073741852,graphName:'_GSTS_SsCopySlots',nodeIndex:3}]);
  assert.deepEqual(def.graph,{nodeCount:72,editorCount:72,exposedPins:3},'the node itself is as it was');
});

test('a call is refused when the save has no such composite node or the inputs do not fit, and other sends are left alone',()=>{
  const save=fixture('composite-node-spliced.gil'),gia=fixture('composite-call.gia');
  refused('COMPOSITE_NODE_NOT_FOUND',()=>toCompositeNodes(fixture('editor-2026-10-13-signal4.gil'),gia));
  const named=name=>changed(gia,graph=>{graph.nodes.find(n=>n.genericId.nodeId===300000).pins.find(p=>p.i1.kind===5).value.bString.val=name;});
  refused('COMPOSITE_NODE_NOT_FOUND',()=>toCompositeNodes(save,named('composite:Copy Slot')));
  refused('COMPOSITE_NODE_INPUTS',()=>toCompositeNodes(save,changed(gia,graph=>{const node=graph.nodes.find(n=>n.genericId.nodeId===300000);node.pins=node.pins.filter(p=>p.i1.kind!==3);})));
  // A send of a signal of the level is no call: nothing of the graph changes.
  const plain=named('SS_other');
  assert.ok(toCompositeNodes(save,plain).equals(plain));
});

// composite-output-spliced.gil: the same small save with the records of a second composite node, "SSCountHeld", which
// a creator made on 2026-11-15 out of a block that counts how many of an item a player holds: two inputs (an entity,
// a text) and ONE OUTPUT (a whole number), a list loop and a local variable inside. composite-output-call.gia: what
// the compiler makes of a graph that calls it twice and reads its output through the stand-in the tool asks for:
//   .on('whenEntityIsCreated',(evt,f)=>{
//     f.printString('before');
//     f.sendSignal('composite:SSCountHeld',evt.eventSourceEntity,'wood');
//     f.printString(f.dataTypeConversion(f.getCustomVariable(evt.eventSourceEntity,'composite:SSCountHeld:0').asType('int'),'str'));
//     f.sendSignal('composite:SSCountHeld',evt.eventSourceEntity,'stone');
//     f.printString(f.dataTypeConversion(f.getCustomVariable(evt.eventSourceEntity,'composite:SSCountHeld:0').asType('int')+1n,'str'));
//   })
// (On an event that needs no signal of the save; the graph's id is that of the fixture's graph it is written in place of.)
test('a composite node made with an output lists it, and the graph that uses it is connected to the node itself',()=>{
  const save=inspectBytes(fixture('composite-output-spliced.gil')),node=save.compositeNodes.find(c=>c.name==='SSCountHeld');
  assert.deepEqual(node.inputs.map(p=>p.type.type1),['Entity','String']);
  assert.deepEqual(node.outputs.map(p=>[p.name,p.type.type1]),[['Value','Integer']]);
  assert.deepEqual(node.usedBy.map(u=>u.graphName),['_GSTS_SsCountHeld']);
});

test('a read of composite:NAME:K after the call becomes a connection to the composite node\'s output K',()=>{
  const save=fixture('composite-output-spliced.gil'),def=inspectBytes(save).compositeNodes.find(c=>c.name==='SSCountHeld');
  const before=graphOf(fixture('composite-output-call.gia'));
  assert.equal(before.nodes.filter(n=>n.genericId.nodeId===50).length,2,'two stand-ins as the compiler wrote them');
  const graph=graphOf(toCompositeNodes(save,fixture('composite-output-call.gia'))),at=index=>graph.nodes.find(n=>n.nodeIndex===index);
  assert.equal(graph.nodes.length,before.nodes.length-2);
  assert.ok(!graph.nodes.some(n=>n.genericId.nodeId===50||n.genericId.nodeId===300000),'no stand-in and no send is left');
  const calls=graph.nodes.filter(n=>String(n.genericId.nodeId)===String(def.definitionId)).map(n=>n.nodeIndex);
  assert.deepEqual(calls,[3,7]);
  // Each reader is connected to the call that came last before its stand-in: the first to node 3, the second to node 7.
  const reads=index=>at(index).pins.flatMap(p=>(p.connects??[]).filter(c=>c.connect.kind==='OutParam').map(c=>[c.id,c.connect.index??0,c.connect2?.index??0]));
  assert.deepEqual(reads(5),[[3,0,0]]);
  assert.deepEqual(reads(9),[[7,0,0]]);
  // The node itself carries no pin for its output, as the one a creator placed carries none.
  assert.ok(at(3).pins.every(p=>p.i1.kind!=='OutParam'));
  // And the whole goes into the save: the graph is listed as a user of the node, twice.
  const written=inspectBytes(inject(save,fixture('composite-output-call.gia'),1073741869));
  assert.deepEqual(written.compositeNodes.find(c=>c.name==='SSCountHeld').usedBy.map(u=>u.nodeIndex),[3,7]);
});

test('a read of an output that is not there, of another type, or before any call is refused',()=>{
  const save=fixture('composite-output-spliced.gil'),gia=fixture('composite-output-call.gia');
  const name=node=>node.pins.find(p=>p.i1.kind===3&&p.i1.index===1).value.bString;
  refused('COMPOSITE_NODE_OUTPUT',()=>toCompositeNodes(save,changed(gia,graph=>{name(graph.nodes.find(n=>n.nodeIndex===4)).val='composite:SSCountHeld:1';})));
  refused('COMPOSITE_NODE_OUTPUT',()=>toCompositeNodes(save,changed(gia,graph=>{graph.nodes.find(n=>n.nodeIndex===4).pins.find(p=>p.i1.kind===4).type=6;})));
  // The first stand-in numbered before the first call: nothing has made the value yet.
  refused('COMPOSITE_NODE_OUTPUT',()=>toCompositeNodes(save,changed(gia,graph=>{
    const stand=graph.nodes.find(n=>n.nodeIndex===4);
    for(const node of graph.nodes)for(const pin of node.pins??[])for(const wire of pin.connects??[])if(wire.id===4)wire.id=0;
    stand.nodeIndex=0;
  })));
  // A stand-in for a node the save does not have at all is refused as the call would be.
  refused('COMPOSITE_NODE_OUTPUT',()=>toCompositeNodes(save,changed(gia,graph=>{name(graph.nodes.find(n=>n.nodeIndex===4)).val='composite:Nothing:0';})));
});

