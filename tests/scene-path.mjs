// Offline check of the pathfinding obstacle component (kind 41): the block equals the editor's bytes for a wall (centre
// and zoom as the editor stored them), placed copies get it where they keep their records, and nothing else changes.
// The fixture is made here from an official sample save: one prefab with one placed copy is picked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {container,fields,field,one} from '../src/scene/wire.mjs';
import {addComponents,listComponents,listPrefabs,listSceneEntities} from '../src/scene-save.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),ws=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-path-'));
const dir=path.join(root,'knowledge','samples','gil'),sample=path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('mhumsn9uap96_')));
const kindOf=b=>Number(fields(b).find(x=>x.id===1&&x.wire===0)?.value);
const blocks=(file,section,id)=>fields(one(container(fs.readFileSync(file)),section)).filter(e=>e.id===1).flatMap(e=>fields(e.data).filter(p=>p.id===id&&p.wire===2&&kindOf(p.data)===41).map(p=>p.raw.toString('hex')));
try{
  // A prefab of the sample that has placed copies.
  const placedIds=new Set(listSceneEntities({mapPath:sample,limit:5000}).entities.map(e=>e.assetId));
  const placed=listPrefabs({mapPath:sample}).prefabs.find(p=>p.kind==='object'&&placedIds.has(p.prefabId));
  assert.ok(placed,'sample has an object prefab with a placed copy');
  const areas=[{size:[2.94,0.23,5.24],offset:[1.51,0.06,0]}];
  const out=addComponents({mapPath:sample,prefab:placed.prefabId,pathObstacles:[{areas}],outputName:'path'},ws);
  assert.ok(out.templates===1&&out.placedCopies>0);
  // The editor's own bytes for SS_Wall: {1: 41, 2: 1, 52: {1: {1: 1, 2: 1, 502: {501: {11: {1: centre, 2: zoom, 3: {}}, 502: "Area 1", 503: 1}}}}}.
  const xyz=v=>Buffer.concat(v.map((n,i)=>{const b=Buffer.alloc(5);b[0]=[0x0d,0x15,0x1d][i];b.writeFloatLE(n,1);return b;}));
  const editor=Buffer.concat([field(1,0,41),field(2,0,1),field(52,2,field(1,2,Buffer.concat([field(1,0,1),field(2,0,1),field(502,2,field(501,2,Buffer.concat([field(11,2,Buffer.concat([field(1,2,xyz([1.51,0.06])),field(2,2,xyz([2.94,0.23,5.24])),field(3,2,Buffer.alloc(0))])),field(502,2,Buffer.from('Area 1')),field(503,0,1)])))])))]);
  assert.equal(blocks(out.mapPath,4,8)[0],field(8,2,editor).toString('hex'));
  assert.equal(blocks(out.mapPath,5,7)[0],field(7,2,editor).toString('hex'));
  const c=listComponents({mapPath:out.mapPath,prefab:placed.prefabId});
  assert.ok(c.found.every(f=>f.pathObstacles===1),'listed');
  // Placed copies keep it in field 7, and a second write replaces the block instead of adding one.
  const again=addComponents({mapPath:out.mapPath,prefab:placed.prefabId,pathObstacles:[{areas,active:false},{areas}],outputName:'path2'},ws).mapPath;
  assert.equal(blocks(again,4,8).length,1);assert.equal(blocks(again,5,7).length,out.placedCopies);
  assert.equal(listComponents({mapPath:again,prefab:placed.prefabId}).found[0].pathObstacles,2);
  assert.throws(()=>addComponents({mapPath:sample,prefab:placed.prefabId,pathObstacles:[{areas:[{radius:1}]}]},ws),e=>e.code==='INVALID_PATH_OBSTACLE');
  console.log('scene-path: ok');
}finally{fs.rmSync(ws,{recursive:true,force:true});}
