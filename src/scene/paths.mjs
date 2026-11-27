// Level paths (路径, section 32) and creature patrol templates (巡逻模板, kind 65 block), read and edited in place.
// Layout (docs/PLATFORM_RULES.zh-CN.md, 2026-11-27): a path is {1: id, 4: [{1: 1, 11: {1: {1: name}}}, {1: 54, 64: {1: {1: id, 3: [waypoint], 501: 1}}}], 5: ...};
// a waypoint is {1: waypoint id, 2: position {1,2,3 floats, zero left out}, 3: rotation (empty or the same floats)}.
// A patrol block is {1: 65, 70: {1: {2: [template]}}}, template {1: number, 2: name, 3: {1: initially effective, 2: loop, 4: start}, 4: {1: path id, 2: [waypoint]}},
// waypoint {1: waypoint id, 2: speed 3601 walk / 3602 run, 3: 3700, 4: radius float, 5: ?, 6: {}}. It lives in a prefab record (section 4, field 6)
// and, as a byte-identical copy, in placed entities (section 5, field 5) and the editor cache (section 8, field 5).
import {fields,field,one,replace} from './wire.mjs';

export const SPEED={walk:3601,run:3602};
// shortcut: 3601 walk / 3602 run is inferred (3601 is the editor default, the guide lists walk first); the loop and start codes are not named, nobody has matched them to the editor yet.
const SPEED_NAME={3601:'walk',3602:'run'};
const kindOf=b=>Number(fields(b).find(f=>f.id===1&&f.wire===0)?.value);
const num=(b,id)=>{const f=fields(b).find(x=>x.id===id&&x.wire===0);return f?Number(f.value):null;};
const vec=b=>[1,2,3].map(i=>{const f=fields(b).find(x=>x.id===i&&x.wire===5);return f?f.data.readFloatLE(0):0;});
const f32=n=>{const b=Buffer.alloc(4);b.writeFloatLE(n);return b;};
const kids=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2);
// A field set in place, or inserted where its number belongs when the message had left it out.
function setField(b,id,wire,data){
  const all=fields(b),raw=field(id,wire,data);
  if(all.some(f=>f.id===id))return Buffer.concat(all.map(f=>f.id===id?raw:f.raw));
  const at=all.findIndex(f=>f.id>id);
  return Buffer.concat([...all.slice(0,at<0?all.length:at).map(f=>f.raw),raw,...(at<0?[]:all.slice(at).map(f=>f.raw))]);
}
const sec=(root,id)=>{const s=fields(root).filter(f=>f.id===id&&f.wire===2);return s.length===1?s[0].data:null;};

// Paths: [{id, name, waypoints: [{index (1-based order), waypointId, position, rotation}]}]
export function readPaths(root){
  const s=sec(root,32);if(!s)return [];
  return kids(s,1).map(r=>{
    const id=num(r.data,1),comps=kids(r.data,4).map(c=>c.data),c54=comps.find(c=>kindOf(c)===54),c1=comps.find(c=>kindOf(c)===1);
    let name=null;try{name=one(one(c1,11),1).toString('utf8');}catch{}
    const body=c54?one(one(c54,64),1):Buffer.alloc(0);
    return {id,name,waypoints:kids(body,3).map((w,i)=>({index:i+1,waypointId:num(w.data,1),position:vec(one(w.data,2)),rotation:vec(fields(w.data).find(x=>x.id===3)?.data??Buffer.alloc(0))}))};
  });
}
const patrolOf=comp=>{const l=fields(comp).find(f=>f.id===70&&f.wire===2);return l&&l.data.length?one(l.data,1):null;};
// Every kind 65 block that holds templates, in the prefab records: {prefabId, block (the whole block), templates}
export function readPatrols(root){
  const s=sec(root,4);if(!s)return [];
  return kids(s,1).flatMap(e=>{
    const prefabId=num(e.data,1);
    return kids(e.data,6).filter(c=>kindOf(c.data)===65&&patrolOf(c.data)&&kids(patrolOf(c.data),2).length).map(c=>({prefabId,block:c.data,templates:kids(patrolOf(c.data),2).map(t=>{
      const t3=one(t.data,3),p=one(t.data,4);
      return {template:num(t.data,1),name:one(t.data,2).toString('utf8'),pathId:num(p,1),initiallyEffective:num(t3,1)===1,loopCode:num(t3,2),startCode:num(t3,4),
        waypoints:kids(p,2).map((w,i)=>{const r=fields(w.data).find(x=>x.id===4&&x.wire===5);return {index:i+1,waypointId:num(w.data,1),speedCode:num(w.data,2),speed:SPEED_NAME[num(w.data,2)]??null,radius:r?r.data.readFloatLE(0):null,field3:num(w.data,3),field5:num(w.data,5)};})};
    })}));
  });
}

const bad=(fail,code,msg,d)=>fail(code,msg,d);
// Applies the edits and returns the new root. fail(code,message,details) throws. No path, template or waypoint is added or removed.
export function patchPaths(root,{waypoints=[],speeds=[],allRun},fail){
  const paths=readPaths(root),patrols=readPatrols(root);
  // Path edits: {pathId -> {waypointId -> [x,y,z]}}
  const moves=new Map();
  for(const [n,e] of waypoints.entries()){
    const hits=paths.filter(p=>p.id===e.path||p.name===e.path);
    if(hits.length!==1)bad(fail,'PATH_NOT_FOUND',hits.length?'Several paths have this name: give the id.':'No path has this id or name.',{entry:n,path:e.path,paths:paths.map(p=>({id:p.id,name:p.name}))});
    const w=hits[0].waypoints[e.index-1];if(!w)bad(fail,'WAYPOINT_NOT_FOUND','This path has no such waypoint (index counts from 1).',{entry:n,path:hits[0].id,waypoints:hits[0].waypoints.length});
    const to=e.position??[w.position[0],e.y,w.position[2]];
    if(!Array.isArray(to)||to.length!==3||!to.every(Number.isFinite))bad(fail,'INVALID_POSITION','Give position [x, y, z] or y.',{entry:n});
    const m=moves.get(hits[0].id)??new Map();if(m.has(w.waypointId))bad(fail,'INVALID_TARGET','A waypoint is given twice.',{entry:n});
    m.set(w.waypointId,to);moves.set(hits[0].id,m);
  }
  // Speed edits: {prefabId -> {template -> {waypointId -> code}}}
  const pick=prefab=>{const h=patrols.filter(p=>p.prefabId===prefab);if(h.length!==1)bad(fail,'PREFAB_NOT_FOUND','No prefab with this id has patrol templates.',{prefab,prefabs:patrols.map(p=>p.prefabId)});return h[0];};
  const sp=new Map();const put=(p,t,w,code)=>{const a=sp.get(p.prefabId)??new Map(),b=a.get(t.template)??new Map();b.set(w.waypointId,code);a.set(t.template,b);sp.set(p.prefabId,a);};
  for(const [n,e] of speeds.entries()){
    const p=pick(e.prefab),t=p.templates.find(x=>x.template===e.template);
    if(!t)bad(fail,'TEMPLATE_NOT_FOUND','This prefab has no such template.',{entry:n,templates:p.templates.map(x=>x.template)});
    const w=t.waypoints[e.index-1];if(!w)bad(fail,'WAYPOINT_NOT_FOUND','This template has no such waypoint (index counts from 1).',{entry:n,waypoints:t.waypoints.length});
    if(!SPEED[e.speed])bad(fail,'INVALID_SPEED','speed is walk or run.',{entry:n});
    put(p,t,w,SPEED[e.speed]);
  }
  if(allRun){const p=pick(allRun.prefab);for(const t of p.templates)for(const w of t.waypoints)put(p,t,w,SPEED[allRun.speed??'run']);}
  if(!moves.size&&!sp.size)bad(fail,'NOTHING_TO_CHANGE','Give waypoints, speeds or allRun.',{});

  const setVec=(w,to)=>{ // x, y, z in order; a float that is already the same stays as it was, a zero left out stays out
    let v=one(w,2);
    for(let i=0;i<3;i++){
      const old=fields(v).find(x=>x.id===i+1);
      if(old?old.data.readFloatLE(0)===Math.fround(to[i]):to[i]===0)continue;
      v=setField(v,i+1,5,f32(to[i]));
    }
    return replace(w,2,2,v);
  };
  let out=root;
  if(moves.size){
    const s=sec(out,32);
    out=replace(out,32,2,Buffer.concat(fields(s).map(r=>{
      if(r.id!==1||r.wire!==2)return r.raw;const m=moves.get(num(r.data,1));if(!m)return r.raw;
      return field(1,2,Buffer.concat(fields(r.data).map(c=>{
        if(c.id!==4||c.wire!==2||kindOf(c.data)!==54)return c.raw;
        const comp=one(c.data,64),body=one(comp,1);
        const nb=Buffer.concat(fields(body).map(w=>w.id===3&&w.wire===2&&m.has(num(w.data,1))?field(3,2,setVec(w.data,m.get(num(w.data,1)))):w.raw));
        return field(4,2,replace(c.data,64,2,replace(comp,1,2,nb)));
      })));
    })));
  }
  if(sp.size){
    const edit=(block,prefabId)=>{
      const m=sp.get(prefabId);let list=patrolOf(block);
      list=Buffer.concat(fields(list).map(t=>{
        if(t.id!==2||t.wire!==2)return t.raw;const tm=m.get(num(t.data,1));if(!tm)return t.raw;
        const p=one(t.data,4);
        const np=Buffer.concat(fields(p).map(w=>w.id===2&&w.wire===2&&tm.has(num(w.data,1))?field(2,2,setField(w.data,2,0,tm.get(num(w.data,1)))):w.raw));
        return field(2,2,replace(t.data,4,2,np));
      }));
      return replace(block,70,2,replace(one(block,70),1,2,list));
    };
    const edited=new Map([...sp.keys()].map(id=>{const p=patrols.find(x=>x.prefabId===id);return [id,{old:p.block,new:edit(p.block,id)}];}));
    // The prefab record, and every other copy of the block (placed entities, editor cache) that is byte for byte the same.
    const swap=(entry,fid,prefabId)=>Buffer.concat(fields(entry).map(c=>{
      if(c.id!==fid||c.wire!==2)return c.raw;
      for(const [id,e] of edited)if((prefabId===undefined||prefabId===id)&&c.data.equals(e.old))return field(fid,2,e.new);
      return c.raw;
    }));
    for(const [s,fid] of [[4,6],[5,5],[8,5]]){
      const data=sec(out,s);if(!data)continue;
      out=replace(out,s,2,Buffer.concat(fields(data).map(e=>e.id===1&&e.wire===2?field(1,2,swap(e.data,fid,s===4?num(e.data,1):undefined)):e.raw)));
    }
  }
  return out;
}
