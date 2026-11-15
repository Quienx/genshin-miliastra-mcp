import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectBytes} from '../../src/adapter.mjs';

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
