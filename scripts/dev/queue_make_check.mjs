// 用一份含编辑器手做消息队列的存档对照工具写的消息队列：按存档里的编号、位置、名字重写模板和两份副本，逐字节比较。
// 用法：node queue_make_check.mjs <存档.gil> <控件名> [第一个字段在编辑器里显示的字] [取结构体的存档.gil]
// （2026-11-17 的探针：控件在 mq_after.gil 里是默认设置，但那里的结构体后来被改过；和控件对得上的结构体在 mq_node.gil 里。）
import fs from 'node:fs';
import {container,fields} from '../../src/scene/wire.mjs';
import {queueRecord} from '../../src/scene-save.mjs';
import {inspectStructs} from '../../src/scene/struct-make.mjs';
const [file,name,shows,structFile]=process.argv.slice(2),root=container(fs.readFileSync(file));
const all=v=>fields(v),one=(b,id)=>all(b).find(f=>f.id===id),num=(b,id)=>Number(one(b,id)?.value??0);
const recs=all(one(root,9).data).filter(f=>f.id===502&&f.wire===2).map(f=>f.data);
const nameOf=r=>{for(const b of all(r).filter(f=>f.id===505)){try{const t=one(one(b.data,12).data,501).data.toString('utf8');if(num(b.data,502)===15)return t;}catch{}}return '';};
const mine=recs.filter(r=>nameOf(r)===name),blocks=(r,id)=>all(r).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const tpl=mine.find(r=>blocks(r,502).some(b=>num(b,502)===4)),struct=inspectStructs(structFile?container(fs.readFileSync(structFile)):root)[0];
struct.fields=struct.fields.map((f,i)=>i===0&&shows?{...f,shows}:f);
// The rectangle of the first state, read back.
const floats=b=>[501,502].map(id=>{const f=one(b,id);return f?f.data.readFloatLE(0):0;});
const rect=(()=>{const s=r=>{const outer=blocks(r,505).find(b=>num(b,502)===12);const inner=one(one(outer,503).data,13).data;const st=one(one(inner,12).data,501).data;const box=one(st,502).data;return [floats(one(box,504).data),floats(one(box,505).data)];};return s(tpl);})();
const slot=num(one(blocks(tpl,502).find(b=>num(b,502)===6),12).data,501),copies=(()=>{const b=blocks(tpl,502).find(b=>num(b,502)===4);const raw=one(one(b,14).data,501).data;const out=[];let v=0,sh=0;for(const x of raw){v+=(x&127)*2**sh;sh+=7;if(x<128){out.push(v);v=0;sh=0;}}return out;})();
const id=num(tpl,501),spec={name,slot,position:rect[0],size:rect[1],struct};
const check=(label,bytes,r)=>console.log(label,bytes.equals(r)?'SAME':'DIFFERENT ('+bytes.length+' vs '+r.length+')');
check('template',queueRecord({...spec,id,copies}),tpl);
for(const c of copies){const r=recs.find(x=>num(x,501)===c);check('copy '+c,queueRecord({...spec,id:c,templateId:id,parent:num(r,504)}),r);}
