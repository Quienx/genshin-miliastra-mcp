// Offline check of editing placed entities by GUID: scene_move_entities, scene_add_components {guids}, variable values in
// scene_list_components. The fixture is made here from an official sample save: one placed entity with a position is
// copied under new GUIDs, so there are three same-named copies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {container,fields,field,replace,one,wrap} from '../src/scene/wire.mjs';
import {listSceneEntities,moveEntities,addComponents,listComponents} from '../src/scene-save.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),ws=fs.mkdtempSync(path.join(os.tmpdir(),'miliastra-guid-'));
const dir=path.join(root,'knowledge','samples','gil'),sample=path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('mhumsn9uap96_')));
const bytes=fs.readFileSync(sample),payload=container(bytes);
const placed=listSceneEntities({mapPath:sample,limit:5000}).entities.find(e=>e.position&&e.guid>1086324737);
assert.ok(placed,'sample has a placed entity with a position');
const entry=fields(one(payload,5)).find(f=>f.id===1&&f.wire===2&&Number(fields(f.data).find(x=>x.id===1&&x.wire===0).value)===placed.guid);
const copy=g=>field(1,2,Buffer.concat(fields(entry.data).map(p=>p.id===1&&p.wire===0?field(1,0,g):p.raw)));
const A=9000000001,B=9000000002;
const seed=path.join(ws,'seed.gil');
fs.writeFileSync(seed,wrap(bytes,replace(payload,5,2,Buffer.concat([one(payload,5),copy(A),copy(B)]))));
const at=(file,g)=>listSceneEntities({mapPath:file,limit:5000}).entities.find(e=>e.guid===g);
const sections=file=>Object.fromEntries(fields(container(fs.readFileSync(file))).map(f=>[f.id,f.raw.toString('hex')]));
const entities=file=>fields(one(container(fs.readFileSync(file)),5)).filter(f=>f.id===1).map(f=>f.raw.toString('hex'));
try{
  // Move two entities, read the positions back; everything else stays.
  const moved=moveEntities({mapPath:seed,moves:[{guid:A,position:[5,0,-10]},{guid:placed.guid,position:[15.5,2,35]}],outputName:'moved'},ws).mapPath;
  assert.deepEqual(at(moved,A).position,[5,0,-10]);assert.deepEqual(at(moved,placed.guid).position,[15.5,2,35]);assert.deepEqual(at(moved,B).position,placed.position);
  assert.equal(entities(moved).filter((h,i)=>h!==entities(seed)[i]).length,2,'only the two moved records changed');
  const [s0,s1]=[sections(seed),sections(moved)];for(const k of Object.keys(s0))if(k!=='5')assert.equal(s1[k],s0[k],'section '+k+' unchanged');
  assert.throws(()=>moveEntities({mapPath:seed,moves:[{guid:123,position:[0,0,0]}]},ws),e=>e.code==='ENTITY_NOT_FOUND');
  // A variable on one GUID of same-named copies.
  const vars=addComponents({mapPath:seed,guids:[B],variables:[{name:'owner',type:'integer',value:2}],outputName:'vars'},ws).mapPath;
  const owner=g=>listComponents({mapPath:vars,guids:[g]}).found[0].variables.find(v=>v.name==='owner');
  assert.equal(owner(B).value,2);assert.equal(owner(A),undefined);assert.equal(owner(placed.guid),undefined);
  const e0=entities(seed),e1=entities(vars);assert.equal(e1.filter((h,i)=>h!==e0[i]).length,1,'only one record changed');
  assert.equal(listComponents({mapPath:vars,guids:[A,B]}).found.length,2);
  assert.throws(()=>addComponents({mapPath:seed,guids:[A,123],variables:[{name:'x',type:'integer'}]},ws),e=>e.code==='ENTITY_NOT_FOUND');
  assert.throws(()=>addComponents({mapPath:seed,guids:[A],entity:'x',variables:[{name:'x',type:'integer'}]},ws),e=>e.code==='INVALID_TARGET');
  // Values of the other basic types read back.
  const all=addComponents({mapPath:seed,guids:[A],variables:[{name:'n',type:'integer',value:-7},{name:'b',type:'boolean',value:true},{name:'f',type:'float',value:1.5},{name:'s',type:'string',value:'red'},{name:'z',type:'integer'}]},ws).mapPath;
  assert.deepEqual(listComponents({mapPath:all,guids:[A]}).found[0].variables.map(v=>v.value),[-7,true,1.5,'red',0]);
  console.log('scene-guid: ok');
}finally{fs.rmSync(ws,{recursive:true,force:true});}
