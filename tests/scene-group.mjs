// Offline check of scene_add_prefab_group / scene_list_prefab_groups on a fixture made from an official sample save
// (one with a prefab library): the group is one entry of asset 10008001 whose member records are the editor's
// ({1: prefab, 2: position, 3: rotation, 5: prefab, 6: number}), it is listed in the library tab of kind 51, a
// group cannot hold a group, and nothing else changes. The byte match against editor-made groups is scripts/dev/group_seed.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {container,fields,field,one,replace,wrap} from '../src/scene/wire.mjs';
import {addPrefabGroup,listPrefabGroups,listPrefabs,GROUP_ASSET} from '../src/scene-save.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),ws=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-group-'));
const dir=path.join(root,'knowledge','samples','gil'),sample=path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('mhumsn9uap96_')));
const num=(b,id)=>Number(fields(b).find(x=>x.id===id&&x.wire===0)?.value);
try{
  // Fixture: the sample plus an empty library tab of kind 51, which newer editors write and the sample may lack.
  const bytes=fs.readFileSync(sample);let r=container(bytes);
  const tabs=fields(one(r,6));
  if(!tabs.some(t=>t.id===1&&num(t.data,1)===51))r=replace(r,6,2,Buffer.concat([one(r,6),field(1,2,Buffer.concat([field(1,0,51),field(3,2,Buffer.alloc(0))]))]));
  const fixture=path.join(ws,'fixture.gil');fs.writeFileSync(fixture,wrap(bytes,r));const before=fs.readFileSync(fixture);
  const prefabs=listPrefabs({mapPath:fixture}).prefabs.filter(p=>p.kind==='object');
  assert.ok(prefabs.length>=2,'sample has two object prefabs');
  const [a,b]=prefabs;
  assert.deepEqual(listPrefabGroups({mapPath:fixture}).groups,[]);
  const out=addPrefabGroup({mapPath:fixture,name:'test group',members:[{prefab:a.prefabId,position:[1.5,0,-2]},{prefab:b.name,position:[0,0.5,3],rotation:[0,90,0]}],outputName:'group'},ws);
  assert.equal(out.members,2);
  const groups=listPrefabGroups({mapPath:out.mapPath}).groups;
  assert.equal(groups.length,1);
  assert.deepEqual([groups[0].prefabId,groups[0].name],[out.prefabId,'test group']);
  assert.deepEqual(groups[0].members.map(m=>[m.prefabId,m.position,m.rotation]),[[a.prefabId,[1.5,0,-2],[0,0,0]],[b.prefabId,[0,0.5,3],[0,90,0]]]);
  // The entry: asset 10008001, members as the editor writes them (zero floats left out, zero rotation empty, prefab twice, number from 1).
  const entry=fields(one(container(fs.readFileSync(out.mapPath)),4)).filter(f=>f.id===1).map(f=>f.data).find(d=>num(d,1)===out.prefabId);
  assert.equal(num(entry,2),GROUP_ASSET);
  const kind61=fields(entry).find(f=>f.id===6&&num(f.data,1)===61),members=fields(one(kind61.data,65)).filter(f=>f.id===1);
  const f32=n=>{const x=Buffer.alloc(4);x.writeFloatLE(n);return x;};
  assert.equal(members[0].data.toString('hex'),Buffer.concat([field(1,0,a.prefabId),field(2,2,Buffer.concat([field(1,5,f32(1.5)),field(3,5,f32(-2))])),field(3,2,Buffer.alloc(0)),field(5,0,a.prefabId),field(6,0,1)]).toString('hex'));
  assert.equal(members[1].data.toString('hex'),Buffer.concat([field(1,0,b.prefabId),field(2,2,Buffer.concat([field(2,5,f32(0.5)),field(3,5,f32(3))])),field(3,2,field(2,5,f32(90))),field(5,0,b.prefabId),field(6,0,2)]).toString('hex'));
  // Library: listed in the tab of kind 51 as {1: 101, 2: id}.
  const tab=fields(one(container(fs.readFileSync(out.mapPath)),6)).find(t=>t.id===1&&num(t.data,1)===51);
  assert.deepEqual(fields(one(tab.data,3)).filter(f=>f.id===5).map(f=>[num(f.data,1),num(f.data,2)]),[[101,out.prefabId]]);
  assert.ok(fs.readFileSync(fixture).equals(before),'the source does not change');
  // Refusals.
  assert.throws(()=>addPrefabGroup({mapPath:out.mapPath,name:'test group',members:[{prefab:a.prefabId,position:[0,0,0]}]},ws),{code:'DUPLICATE_PREFAB_NAME'});
  assert.throws(()=>addPrefabGroup({mapPath:out.mapPath,name:'nested',members:[{prefab:out.prefabId,position:[0,0,0]}]},ws),{code:'PREFAB_NOT_FOUND'});
  assert.throws(()=>addPrefabGroup({mapPath:fixture,name:'x',members:[{prefab:'no such prefab',position:[0,0,0]}]},ws),{code:'PREFAB_NOT_FOUND'});
  assert.throws(()=>addPrefabGroup({mapPath:fixture,name:'x',members:[{prefab:a.prefabId,position:[0,0]}]},ws),{code:'INVALID_MEMBERS'});
  assert.throws(()=>addPrefabGroup({mapPath:fixture,name:'x',members:[]},ws),{code:'INVALID_MEMBERS'});
  console.log('scene-group ok');
}finally{fs.rmSync(ws,{recursive:true,force:true});}
