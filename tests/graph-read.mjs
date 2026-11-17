// Offline check of read_graph on a fixture save: node names, literal values, enums by name, wires, branches,
// composite nodes and signal nodes come out as the graph has them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readGraph} from '../src/scene/graph-read.mjs';

const bytes=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','composite-output-spliced.gil'));
const [stage]=readGraph(bytes,{name:'_GSTS_CcStage'}).graphs,node=n=>stage.nodes.find(x=>x.n===n);
assert.equal(stage.side,'server');
assert.ok(stage.nodes.every(n=>n.node!=='unknown'));
assert.deepEqual(node(3),{n:3,node:'Start Timer',id:79,in:{'Target Entity':'<- #1','Timer Name':'CC_SHOW','Loop':0,'Timer Sequence':'<- #2'},next:[4]});
assert.deepEqual(node(8).next,{0:[10],1:[11]});
assert.equal(node(14).in['Display Status'],'UIControlGroupStatus_On (1901)');
assert.equal(node(15).node,'monitor CC_say');
assert.equal(node(17).in.String,'<- #15.out3');
const [held]=readGraph(bytes,{graphId:1073741869}).graphs;
assert.deepEqual(held.nodes.find(x=>x.n===3).node,'composite: SSCountHeld');
assert.throws(()=>readGraph(bytes,{graphId:1}),{code:'GRAPH_NOT_FOUND'});
console.log('graph-read: ok');
