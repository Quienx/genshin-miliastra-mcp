// Offline check of scene_list_paths / scene_update_paths on an official sample save (a path with two waypoints and a
// patrol template of one creature prefab, copied into the placed entities and the editor cache).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {listPaths,updatePaths} from '../src/scene-save.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),ws=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-paths-'));
const dir=path.join(root,'knowledge','samples','gil'),sample=path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('mh6riq9wvxqq_')));
const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])n++;return n;};
try{
  const before=listPaths({mapPath:sample}),p=before.paths[0],pf=before.patrols.find(x=>x.templates.length),t=pf.templates[0];
  assert.equal(p.waypoints.length,2);assert.equal(t.waypoints.length,2);assert.equal(t.pathId,p.id);assert.equal(t.waypoints[0].speed,'walk');
  const bytes=fs.readFileSync(sample);
  // Round trip: the same values written give the same file.
  const same=updatePaths({mapPath:sample,waypoints:[{path:p.id,index:2,position:p.waypoints[1].position}],speeds:[{prefab:pf.prefabId,template:t.template,index:1,speed:'walk'}],outputName:'paths-same'},ws);
  assert.ok(fs.readFileSync(same.mapPath).equals(bytes),'round trip is byte identical');
  // One y and one speed: same length, only those bytes differ (4 float bytes at most, one speed byte in each of the 3 copies).
  const out=updatePaths({mapPath:sample,waypoints:[{path:p.name,index:2,y:1.5}],speeds:[{prefab:pf.prefabId,template:t.template,index:2,speed:'run'}],outputName:'paths-edit'},ws);
  const after=fs.readFileSync(out.mapPath);assert.equal(after.length,bytes.length);
  const n=diff(bytes,after);assert.ok(n>=4&&n<=7,'bytes changed: '+n);
  const q=out.paths[0].waypoints,w=out.patrols.find(x=>x.templates.length).templates[0].waypoints;
  assert.equal(q[1].position[1],1.5);assert.deepEqual(q[0].position,p.waypoints[0].position);assert.equal(q[1].aboveGround,1.5);
  assert.deepEqual(w.map(x=>x.speed),['walk','run']);
  // allRun makes every waypoint run, in the prefab record and in both copies.
  const run=updatePaths({mapPath:out.mapPath,allRun:{prefab:pf.prefabId},outputName:'paths-run'},ws);
  assert.ok(run.patrols.find(x=>x.templates.length).templates[0].waypoints.every(x=>x.speed==='run'));
  assert.equal(diff(after,fs.readFileSync(run.mapPath)),3);
  // Nothing is added: unknown path, template, index, speed and prefab are refused.
  for(const a of [{waypoints:[{path:99,index:1,y:0}]},{waypoints:[{path:p.id,index:3,y:0}]},{speeds:[{prefab:pf.prefabId,template:9,index:1,speed:'run'}]},{speeds:[{prefab:pf.prefabId,template:1,index:5,speed:'run'}]},{speeds:[{prefab:1,template:1,index:1,speed:'run'}]},{}])
    assert.throws(()=>updatePaths({mapPath:sample,...a},ws),e=>e.code!==undefined,JSON.stringify(a));
  console.log('scene-paths ok');
}finally{fs.rmSync(ws,{recursive:true,force:true});}
