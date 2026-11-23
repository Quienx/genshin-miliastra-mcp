// Offline check of scene_add_struct, scene_add_notification_queue and the struct: calls in a graph's source.
// The editor's own bytes come from a save where a creator made a structure "Structure" (text, icon: string; count:
// integer) and a notification queue "MQ_Probe" on it by hand (2026-11-17); that save is a creator's level and is not
// in the repository, so what it holds is kept here as ids, pin numbers and sha256 sums of the records
// (scripts/dev/struct_make_check.mjs and queue_make_check.mjs compare against such a save itself). No message showed
// until the creator gave each of the tool's queue records an asset group to draw its item with (a second save, same day):
// those records too are kept here as sums.
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
import {addStruct,addNotificationQueue,queueRecord,queueAssets,listInterface,addComponents,listComponents} from '../src/scene-save.mjs';
import {structRecord,structDefinitions,inspectStructs,structVariableBlock,textDictBlock,structVariableOf,structVariablesNamed} from '../src/scene/struct-make.mjs';
import {toStructNodes,toStructValues,inject} from '../src/adapter.mjs';
import {readGraph} from '../src/scene/graph-read.mjs';

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

  // The asset group a creator added to the tool's queue (SS_Notes on SS_Note), and the queue's layout copy naming it.
  assert.equal(sha(Buffer.concat(queueAssets({id:1073782149,parts:[1073782150,1073782151,1073782152,1073782153],text:'{4:count}{4:text}'}))),'89c9b93209d8d447fc14c9045aef9b2be6448fc7c00a92e4437b492c50836c57','asset group');
  const note={name:'SS_Note',fields:[{name:'text',type:'string',place:1},{name:'count',type:'int',place:2}]};
  assert.equal(sha(queueRecord({id:1073782133,name:'SS_Notes',slot:39852,templateId:1073782131,parent:1073741825,position:[-655.3124389648438,-1.2499617338180542],size:[260,170],struct:note,assets:1073782154})),'cb73c961fee2175226aefc9087420622728edc0c32b19c96df537e5a9c626883','queue copy with its group');

  // Writing them into a save.
  const base=path.join(dir,'composite-node-spliced.gil'),made=addStruct({mapPath:base,name:'SS_Note',fields:[{name:'text',type:'string'},{name:'count',type:'int'}]},workspace);
  const saved=inspectStructs(container(fs.readFileSync(made.mapPath)));
  assert.deepEqual(saved.map(s=>[s.name,s.fields.map(f=>f.name+':'+f.type)]),[['SS_Note',['text:string','count:int']]]);
  assert.equal(saved[0].assemble.definitionId,made.assembleId);
  const defs=fields(container(fs.readFileSync(made.mapPath))).find(f=>f.id===10).data,mine=fields(defs).filter(f=>f.id===2).flatMap(f=>msgs(f.data,1)).map(r=>Def.toObject(Def.decode(r),opt)).filter(d=>d.type?.assemble?.id==made.structId||d.type?.split?.id==made.structId||d.type?.modify?.id==made.structId);
  assert.deepEqual(mine.map(d=>d.type.kind),['Assembly','Split','Modify','Assembly','Split','Assembly','Split','Assembly','Split']);
  assert.throws(()=>addStruct({mapPath:made.mapPath,name:'SS_Note',fields:[{name:'a',type:'int'}]},workspace),/DUPLICATE_STRUCT_NAME|already has a structure/);
  const queue=addNotificationQueue({mapPath:made.mapPath,name:'SS_Notes',struct:'SS_Note'},workspace);
  assert.ok(JSON.stringify(listInterface({mapPath:queue.mapPath})).includes('SS_Notes'));
  assert.equal(queue.text,'{4:text} {4:count}');
  { // three control records and three groups of five, the groups in the root list
    const before=fields(fields(container(fs.readFileSync(made.mapPath))).find(f=>f.id===9).data),after=fields(fields(container(fs.readFileSync(queue.mapPath))).find(f=>f.id===9).data);
    const count=list=>list.filter(f=>f.id===502&&f.wire===2).length;assert.equal(count(after)-count(before),18);
    const names=after.filter(f=>f.id===502&&f.wire===2).map(f=>f.data.toString('latin1')).filter(t=>t.includes('Default Status Asset Group')).length;assert.equal(names,3);
  }
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

  // Variables that hold structures, as a creator set them on the player template (StructProbe, 2026-11-22): the
  // editor's blocks of its first copy, with the numbers it gave the four values, as sha256 sums.
  const item={id:1077936129,name:'ItemInstance',fields:[{name:'itemId',type:'string'},{name:'count',type:'int'},{name:'wear',type:'int'},{name:'element',type:'int'}]};
  const start={1:{itemId:'wood_id',count:5},2:{itemId:'pickaxe_id',count:1,wear:37,element:1}},bad=m=>{throw new Error(m);};
  let serial=1073742506;const next=()=>serial++;
  assert.equal(sha(structVariableBlock({name:'probeDict',type:'dict',struct:'ItemInstance',value:start},[item],next,bad)),'d86cde4f4d53a676f2a6c55ecf53544dd8191016d5bf0054c26647c3f9d64df0','dictionary variable');
  assert.equal(sha(structVariableBlock({name:'probeList',type:'structList',struct:'ItemInstance',value:Object.values(start)},[item],next,bad)),'5bb69e6aa26185ba8a2db4129ab0908cb9c378deb63d91376a9ef209dac51c16','list variable');
  const withItem=addStruct({mapPath:base,name:'ItemInstance',fields:item.fields},workspace);
  // One structure (struct): its value is a dictionary's structure value, read from the user's slot1 (2026-11-23):
  // {2: name, 3: 25, 4: {1: 25, 2: tag, 35: fields}, 5: 1, 6: {1: 25, 2: {1: 1, 2: structure id}}}; read back as such.
  const one=structVariableBlock({name:'probeOne',type:'struct',struct:'ItemInstance',value:start[1]},[item],next,bad);
  assert.deepEqual(structVariableOf(one),{type:'struct',structId:item.id},'one structure');
  assert.equal(one.subarray(0,13).toString('hex'),'120870726f62654f6e65181922','its name, then type 25 and its value');
  // Configuration ID and Prefab ID fields (inferred, 2026-11-23: VarType 20 / 21, client 18 / 19, IdBase, the value in
  // field 10 + type): a value goes in field 30 / 31 of its field, as a whole number in field 1.
  const ids={id:1077936140,name:'Def',fields:[{name:'attack',type:'config'},{name:'own',type:'prefab'}]};
  const idBlock=structVariableBlock({name:'probeDef',type:'struct',struct:'Def',value:{attack:1098907649,own:1077936213}},[ids],next,bad);
  assert.ok(idBlock.includes(Buffer.from([0xf2,0x01,0x0a,0x0a,0x08,0x08,0x01,0x10,0x81,0x80,0x80,0x8c,0x04])),'the attack in field 30, a reference {1: 1, 2: id}');
  assert.ok(idBlock.includes(Buffer.from([0xfa,0x01,0x0a,0x0a,0x08,0x08,0x01,0x10,0xd5,0x80,0x80,0x82,0x04])),'the prefab in field 31, the same shape');
  assert.throws(()=>structVariableBlock({name:'x',type:'struct',struct:'Def',value:{attack:-1}},[ids],next,bad),/configuration id/);
  const held=addComponents({mapPath:withItem.mapPath,prefab:'player',variables:[{name:'probeDict',type:'dict',struct:'ItemInstance',value:start},{name:'probeList',type:'structList',struct:'ItemInstance',value:Object.values(start)}]},workspace);
  const copies=listComponents({mapPath:held.mapPath,prefab:'player'}).found;
  assert.ok(copies.length>1&&copies.every(c=>JSON.stringify(c.variables)===JSON.stringify([{name:'probeDict',type:'dict',struct:'ItemInstance'},{name:'probeList',type:'structList',struct:'ItemInstance'}])),'every copy holds both');
  { // each copy numbers its values apart, as the editor does: {502: {2: 28, 4: number}}
    const root=container(fs.readFileSync(held.mapPath)),mark=Buffer.from([0xb2,0x1f,0x08,0x10,0x1c,0x20]),ids=[];
    for(let at=root.indexOf(mark);at>=0;at=root.indexOf(mark,at+1))ids.push(root.subarray(at+6,at+11).toString('hex'));
    assert.equal(ids.length,copies.length*4);assert.equal(new Set(ids).size,ids.length,'value numbers are unique');
  }
  assert.throws(()=>addComponents({mapPath:withItem.mapPath,prefab:'player',variables:[{name:'x',type:'dict',struct:'ItemInstance',value:{1:{bogus:1}}}]},workspace),/no field bogus/);
  assert.throws(()=>addComponents({mapPath:withItem.mapPath,prefab:'player',variables:[{name:'x',type:'structList',struct:'Nope'}]},workspace),/no structure/);

  // Structure values in a graph, struct-values-call.gia compiled by the tool from:
  //   const d = f.getCustomVariable(p, 'probeDict').asDict('int', 'int')
  //   f.sendSignal('split:ItemInstance', f.queryDictionaryValueByKey(d, 1n))
  //   f.printString(f.getCustomVariable(p, 'split:ItemInstance:0').asType('str'))
  //   f.printString(f.dataTypeConversion(f.getCustomVariable(p, 'split:ItemInstance:1').asType('int'), 'str'))
  //   f.sendSignal('modify:ItemInstance', f.queryDictionaryValueByKey(d, 1n), 'count', 99n)
  //   f.listIterationLoop(f.getCustomVariable(p, 'probeList').asType('int_list'), it => {
  //     f.sendSignal('split:ItemInstance', it); f.printString(f.getCustomVariable(e, 'split:ItemInstance:0').asType('str')) })
  //   f.sendSignal('struct:ItemInstance', 'axe_id', 1n, 0n, 0n)
  //   f.setOrAddKeyValuePairsToDictionary(d, 3n, f.getCustomVariable(p, 'struct:ItemInstance:0').asType('int'))
  //   f.removeKeyValuePairsFromDictionaryByKey(d, 2n)
  // and struct-values-misuse.gia from f.printString(f.dataTypeConversion(f.queryDictionaryValueByKey(d, 1n), 'str')).
  // The pins checked are those of the creator's graph in StructProbe (types, indexOfConcrete, usingStruct numbers).
  const heldBytes=fs.readFileSync(held.mapPath),call=fs.readFileSync(path.join(dir,'struct-values-call.gia'));
  const typedOut=toStructValues(heldBytes,toStructNodes(heldBytes,call)),g2=rootMessage.toObject(rootMessage.decode(typedOut.subarray(20,typedOut.length-4)),opt).graph.graph.inner.graph;
  const by=id=>g2.nodes.filter(n=>Number(n.genericId.nodeId)===id),pinOf=(n,kind,index=0)=>n.pins.find(p=>p.i1.kind===kind&&(p.i1.index??0)===index);
  const shape=p=>{const v=p.value?.bConcreteValue,t=v?.value?.itemType?.type_server;return [p.type,v?.indexOfConcrete??0,String(t?.items?.structId??t?.item?.structId)];};
  const sid=String(withItem.structId),using=n=>[n.usingStruct[0].typeXxx,n.usingStruct[0].alwaysOneXxxx,n.usingStruct[0].structId?String(n.usingStruct[0].structId.structId):null];
  const [getDict,getList]=['probeDict','probeList'].map(v=>by(50).find(n=>n.pins.some(p=>p.value?.bString?.val===v)));
  assert.deepEqual([getDict.concreteId,shape(pinOf(getDict,'OutParam')),using(getDict)],[undefined,[27,20,sid],[74,2,null]],'Get of a dictionary');
  assert.deepEqual([getList.concreteId,shape(pinOf(getList,'OutParam')),using(getList)],[undefined,[26,22,sid],[175,1,sid]],'Get of a list');
  for(const q of by(1158))assert.deepEqual([q.concreteId,shape(pinOf(q,'InParam')),shape(pinOf(q,'OutParam')),using(q)],[undefined,[27,0,sid],[25,10,sid],[54,2,null]],'Query');
  const [loop]=by(509);assert.deepEqual([loop.concreteId,shape(pinOf(loop,'InParam')),shape(pinOf(loop,'OutParam')),using(loop)],[undefined,[26,10,sid],[25,10,sid],[10,1,sid]],'loop');
  const [put]=by(948),[drop]=by(1298);
  assert.deepEqual([shape(pinOf(put,'InParam')),shape(pinOf(put,'InParam',2)),shape(pinOf(drop,'InParam'))],[[27,0,sid],[25,10,sid],[27,0,sid]],'Set or Add, Remove');
  const splits=by(withItem.splitId);assert.equal(splits.length,2);
  for(const s of splits)assert.deepEqual(s.pins.map(p=>[p.i1.kind,p.type,!!p.connects?.length]),[['InParam',25,true]],'Split: the structure alone');
  assert.equal(pinOf(put,'InParam',2).connects[0].id,by(withItem.assembleId)[0].nodeIndex,'the Assemble node feeds Set or Add');
  const [modify]=by(withItem.modifyId);
  assert.deepEqual(modify.pins.map(p=>[p.i1.kind,p.i1.index??0,p.i2.index??0,p.type??null]),[['OutFlow',0,0,null],['InParam',0,0,25],['InParam',4,3,3],['InParam',5,4,4]],'Modify: flow, structure, count and its flag');
  assert.equal(pinOf(modify,'InParam',4).value.bInt.val,99);assert.equal(pinOf(modify,'InParam',5).value.bEnum.val,1);
  // The reads are gone, their wires go from the split's outputs.
  assert.ok(!by(50).some(n=>n.pins.some(p=>/^split:|^struct:/.test(p.value?.bString?.val??''))));
  assert.ok(g2.nodes.some(n=>n.pins.some(p=>(p.connects??[]).some(w=>w.id===splits[0].nodeIndex&&w.connect.index===1))),'count read from output 1');
  assert.deepEqual(g2.affiliations.map(a=>[Number(a.info.source.id),a.info.typeXxx,a.type.type]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]),[[50,74,23],[50,175,23],[509,10,8],[948,54,320],[1158,54,320],[1298,54,320]]);
  // A structure given to anything else, and a graph on a save without the variables, are refused.
  assert.throws(()=>toStructValues(heldBytes,toStructNodes(heldBytes,fs.readFileSync(path.join(dir,'struct-values-misuse.gia')))),{code:'STRUCT_VALUE_MISUSED'});
  const bare=fs.readFileSync(withItem.mapPath);
  assert.throws(()=>toStructValues(bare,toStructNodes(bare,call)),{code:'STRUCT_VALUE_EXPECTED'});
  // A node graph variable that holds a structure, struct-graph-variable-call.gia compiled by the tool from:
  //   g.server({id: 1073741825, name: '_GSTS_held', variables: {held: 0n}})
  //   f.set('held', f.queryDictionaryValueByKey(f.getCustomVariable(p, 'probeDict').asDict('int', 'int'), 1n))
  //   f.sendSignal('modify:ItemInstance', f.get('held'), 'count', 5n)
  //   f.sendSignal('split:ItemInstance', f.get('held')); f.printString(f.getCustomVariable(p, 'split:ItemInstance:0').asType('str'))
  // typed as the editor typed SsSlots' probeSlot in the user's sample (2026-11-22).
  const held2=toStructValues(heldBytes,toStructNodes(heldBytes,fs.readFileSync(path.join(dir,'struct-graph-variable-call.gia'))));
  const g3=rootMessage.toObject(rootMessage.decode(held2.subarray(20,held2.length-4)),opt).graph.graph.inner.graph,by3=id=>g3.nodes.filter(n=>Number(n.genericId.nodeId)===id);
  const [variable]=g3.graphValues;
  assert.deepEqual([variable.name,variable.type,String(variable.structId),variable.values.bStruct.items.length],['held','Struct',sid,4],'the graph variable is a structure');
  const [setVar]=by3(323),getVars=by3(337);assert.equal(getVars.length,2);
  assert.deepEqual([setVar.concreteId,shape(pinOf(setVar,'InParam',1)),using(setVar)],[undefined,[25,21,sid],[174,1,sid]],'Set Node Graph Variable');
  for(const n of getVars)assert.deepEqual([n.concreteId,shape(pinOf(n,'OutParam')),using(n)],[undefined,[25,21,sid],[174,1,sid]],'Get Node Graph Variable');
  assert.ok(g3.affiliations.some(a=>Number(a.info.source.id)===323&&a.info.typeXxx===174&&a.type.type===1)&&g3.affiliations.some(a=>Number(a.info.source.id)===337&&a.type.type===1));
  // read_graph names the structure's nodes and pins.
  const injected=inject(heldBytes,call,1073741825,true),[seen]=readGraph(injected,{graphId:1073741825}).graphs;
  assert.ok(seen.nodes.some(n=>n.node==='Split Structure ItemInstance'&&n.out.out1==='count'));
  assert.ok(seen.nodes.some(n=>n.node==='Modify Structure ItemInstance'&&n.in.count===99&&n.in['set count']==='True (1)'));
  assert.ok(seen.nodes.some(n=>n.node==='Get Custom Variable'&&n.out?.out0==='Dictionary<Integer, ItemInstance>'));
  // A dictionary from integers to texts with no structure: the block a creator's `accepts` (player template, 100..105 ->
  // head..weapon, 2026-11-22) holds, kept as its sum; neither reader takes it for a structure variable.
  const accepts=textDictBlock({name:'accepts',type:'dict',value:{100:'head',101:'chest',102:'legs',103:'feet',104:'hands',105:'weapon'}},m=>{throw new Error(m);});
  assert.equal(accepts.length,265);
  assert.equal(createHash('sha256').update(accepts).digest('hex'),'848c981db2b86594564c03cb001dbc7fee55708502f469ec4d25f5911f0060e1');
  assert.equal(structVariableOf(accepts),null);
  assert.equal(structVariablesNamed(accepts,['accepts']).size,0);
  assert.throws(()=>textDictBlock({name:'bad',type:'dict',value:{x:'head'}},m=>{throw new Error(m);}));
  console.log('scene-struct: ok');
}finally{fs.rmSync(workspace,{recursive:true,force:true});}
