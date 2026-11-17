// Offline check of scene_add_struct, scene_add_notification_queue and the struct: calls in a graph's source.
// The editor's own bytes come from a save where a creator made a structure "Structure" (text, icon: string; count:
// integer) and a notification queue "MQ_Probe" on it by hand (2026-11-17); that save is a creator's level and is not
// in the repository, so what it holds is kept here as ids, pin numbers and sha256 sums of the records
// (scripts/dev/struct_make_check.mjs and queue_make_check.mjs compare against such a save itself).
// struct-queue-call.gia is a graph compiled by the tool from:
//   f.printString('before'); f.sendSignal('struct:SS_Note','Wood',3n);
//   f.refreshNotificationQueue(evt.eventSourceEntity as any,1073782132n,1n); f.printString('after');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {container,fields} from '../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
import {addStruct,addNotificationQueue,queueRecord,listInterface} from '../src/scene-save.mjs';
import {structRecord,structDefinitions,inspectStructs} from '../src/scene/struct-make.mjs';
import {toStructNodes} from '../src/adapter.mjs';

const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures'),workspace=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-struct-'));
const sha=b=>createHash('sha256').update(b).digest('hex'),msgs=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const opt={longs:String,enums:String},{root,rootMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef');
try{
  // The editor's bytes.
  const list=[{name:'text',type:'string'},{name:'icon',type:'string'},{name:'count',type:'int'}];
  assert.equal(sha(structRecord({id:1077936129,name:'Structure',list,counter:6})),'352ac8058f2221dc0547076f7a026f22be2040441477d3bccb76825680216f73','structure record');
  const pins=[141,674,701,168,169,194,702,737,220,221,246,738,272,273,783,296,784,599,317,807,808,342,343,368,838,839,397,881,882,424,425,450,886,887,482,888,889,507,508,529,890,891];
  let k=0;assert.equal(sha(Buffer.concat(structDefinitions({structId:1077936129,name:'Structure',list,first:1610612872},()=>pins[k++]))),'cb3e72422e90fc7f6203f0aead9bbd620f12a315648848e591daf40bb6770d72','nine definitions');
  const struct={name:'Structure',fields:list.map((f,i)=>({...f,place:i+1,...(i?{}:{shows:'Wood'})}))};
  // The rectangle as the editor stored it (its floats are not round).
  const template=queueRecord({id:1073782126,name:'MQ_Probe',slot:39851,copies:[1073782129,1073782130],position:[-669.3750610351562,20.250043869018555],size:[258.75006103515625,120.0000991821289],struct});
  assert.equal(sha(template),'7efab20262e54bff70db3264d7d68387b654b90a057c7b2bee77d05c7b3efaa4','queue template');

  // Writing them into a save.
  const base=path.join(dir,'composite-node-spliced.gil'),made=addStruct({mapPath:base,name:'SS_Note',fields:[{name:'text',type:'string'},{name:'count',type:'int'}]},workspace);
  const saved=inspectStructs(container(fs.readFileSync(made.mapPath)));
  assert.deepEqual(saved.map(s=>[s.name,s.fields.map(f=>f.name+':'+f.type)]),[['SS_Note',['text:string','count:int']]]);
  assert.equal(saved[0].assemble.definitionId,made.assembleId);
  const defs=fields(container(fs.readFileSync(made.mapPath))).find(f=>f.id===10).data,mine=fields(defs).filter(f=>f.id===2).flatMap(f=>msgs(f.data,1)).map(r=>Def.toObject(Def.decode(r),opt)).filter(d=>d.type?.assemble?.id==made.structId||d.type?.split?.id==made.structId||d.type?.modify?.id==made.structId);
  assert.deepEqual(mine.map(d=>d.type.kind),['Assembly','Split','Modify','Assembly','Split','Assembly','Split','Assembly','Split']);
  assert.throws(()=>addStruct({mapPath:made.mapPath,name:'SS_Note',fields:[{name:'a',type:'int'}]},workspace),/DUPLICATE_STRUCT_NAME|already has a structure/);
  const queue=addNotificationQueue({mapPath:made.mapPath,name:'SS_Notes',struct:'SS_Note'},workspace);
  assert.ok(listInterface({mapPath:queue.mapPath}).controls?.some?.(c=>c.name==='SS_Notes')??JSON.stringify(listInterface({mapPath:queue.mapPath})).includes('SS_Notes'));
  assert.throws(()=>addNotificationQueue({mapPath:made.mapPath,name:'X',struct:'Nope'},workspace),/STRUCT_NOT_FOUND|no structure/);

  // A graph's struct: call becomes the Assemble node, put on the queue node's fourth input.
  const gia=fs.readFileSync(path.join(dir,'struct-queue-call.gia')),out=toStructNodes(fs.readFileSync(made.mapPath),gia);
  const graph=rootMessage.toObject(rootMessage.decode(out.subarray(20,out.length-4)),opt).graph.graph.inner.graph,nodes=graph.nodes;
  const assemble=nodes.find(n=>Number(n.genericId.nodeId)===made.assembleId),queueNode=nodes.find(n=>n.genericId.nodeId===833);
  assert.ok(assemble&&queueNode,'Assemble and queue nodes');
  assert.deepEqual(assemble.pins.map(p=>[p.i1.kind,p.compositePinIndex]),[['InParam',saved[0].assemble.pins[0]],['InParam',saved[0].assemble.pins[1]]],'Assemble: two inputs, no flow, no name pin');
  const fourth=queueNode.pins.find(p=>p.i1.kind==='InParam'&&p.i1.index===3);
  assert.equal(fourth.type,25);assert.equal(fourth.connects[0].id,assemble.nodeIndex);assert.equal(fourth.connects[0].connect.kind,'OutParam');
  assert.equal(String(queueNode.usingStruct[0].structId.structId),String(made.structId));
  assert.equal(graph.affiliations.filter(a=>a.type?.type===66002).length,1);
  // The flow skips the Assemble node: nothing flows into it.
  assert.ok(!nodes.some(n=>(n.pins??[]).some(p=>p.i1.kind==='OutFlow'&&(p.connects??[]).some(w=>w.id===assemble.nodeIndex))));
  assert.ok(nodes.some(n=>(n.pins??[]).some(p=>p.i1.kind==='OutFlow'&&(p.connects??[]).some(w=>w.id===queueNode.nodeIndex))));
  // A save without that structure is refused.
  assert.throws(()=>toStructNodes(fs.readFileSync(base),gia),/STRUCT_NOT_FOUND|no structure/);
  console.log('scene-struct: ok');
}finally{fs.rmSync(workspace,{recursive:true,force:true});}
