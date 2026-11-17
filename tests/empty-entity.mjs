// Offline check of the stand-in for an empty entity pin: a read of the custom variable 'entity:none' and its wires are
// taken out of a compiled graph, and nothing else changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {toEmptyEntities} from '../src/adapter.mjs';

const {rootMessage}=loadGiaProto(),decode=b=>rootMessage.decode(b.subarray(20,b.length-4)),graphOf=root=>root.graph.graph.inner.graph;
const gia=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','composite-call.gia'));
assert.equal(toEmptyEntities(gia),gia,'a graph without the stand-in is left as it is');
const root=decode(gia),graph=graphOf(root),last=Math.max(...graph.nodes.map(n=>n.nodeIndex)),target=graph.nodes[0];
graph.nodes.push({nodeIndex:last+1,genericId:{nodeId:50},concreteId:{nodeId:50},pins:[{i1:{kind:3,index:1},value:{bString:{val:'entity:none'}}}]});
target.pins=[...(target.pins??[]),{i1:{kind:3,index:7},connects:[{id:last+1,connect:{kind:4}}]}];
const payload=Buffer.from(rootMessage.encode(root).finish()),header=Buffer.from(gia.subarray(0,20));
header.writeUInt32BE(payload.length+20,0);header.writeUInt32BE(payload.length,16);
const after=graphOf(decode(toEmptyEntities(Buffer.concat([header,payload,gia.subarray(-4)]))));
assert.equal(after.nodes.length,graph.nodes.length-1,'the stand-in is gone');
assert.ok(!after.nodes.some(n=>n.nodeIndex===last+1));
assert.deepEqual(after.nodes.find(n=>n.nodeIndex===target.nodeIndex).pins.at(-1).connects??[],[],'the pin it fed is unwired');
console.log('empty-entity: ok');
