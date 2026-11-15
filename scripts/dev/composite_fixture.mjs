// node scripts/dev/composite_fixture.mjs <seed.gil> <source.gil> <out.gil>: a small save for the tests of composite nodes.
// The composite nodes of <source> (their definitions and inner graphs) and the graphs that use them are copied into
// section 10 of <seed>, a small save without any. The result is put together here, not written by the game: it is for
// reading with inspect_map in tests, not for importing. tests/fixtures/composite-node-spliced.gil was made this way on
// 2026-11-15 from editor-2026-10-13-signal4.gil and a save in which 71 nodes of one graph had been wrapped by hand
// (生成复合节点) into a composite node "Copy Slots".
import fs from 'node:fs';
import {container,fields,field,wrap} from '../../src/scene/wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';
const [seedFile,sourceFile,outFile]=process.argv.slice(2);
if(!outFile){console.error('usage: composite_fixture.mjs <seed.gil> <source.gil> <out.gil>');process.exit(1);}
const {root,nodeGraphMessage}=loadGiaProto(),Def=root.lookupType('CompositeDef');
const inner=g=>fields(g.data).filter(f=>f.id===1&&f.wire===2).map(f=>f.data);
const groups=fields(container(fs.readFileSync(sourceFile))).filter(f=>f.id===10&&f.wire===2).flatMap(s=>fields(s.data).filter(f=>f.wire===2));
// The definitions whose type is Composite, and the ids their nodes have in a graph.
const defs=groups.filter(g=>g.id===2&&inner(g).some(raw=>{try{return Def.toObject(Def.decode(raw),{enums:String}).type?.kind==='Composite';}catch{return false;}}));
const ids=new Set(defs.flatMap(inner).map(raw=>String(Def.decode(raw).id?.genericId?.id)));
const uses=g=>inner(g).some(raw=>{try{return (nodeGraphMessage.decode(raw).nodes??[]).some(n=>ids.has(String(n.genericId?.nodeId)));}catch{return false;}});
const taken=[...defs,...groups.filter(g=>g.id===4),...groups.filter(g=>g.id===1&&uses(g))];
if(!defs.length){console.error('no composite node in '+sourceFile);process.exit(1);}
const seed=fs.readFileSync(seedFile),payload=container(seed);
let placed=false;
const out=Buffer.concat(fields(payload).map(f=>{
  if(f.id!==10||f.wire!==2||placed)return f.raw;
  placed=true;return field(10,2,Buffer.concat([f.data,...taken.map(g=>g.raw)]));
}));
if(!placed){console.error('the seed has no section 10');process.exit(1);}
fs.writeFileSync(outFile,wrap(seed,out));
console.log(`${outFile}: ${defs.length} definition(s), ${groups.filter(g=>g.id===4).length} inner graph(s), ${groups.filter(g=>g.id===1&&uses(g)).length} graph(s) that use them; ${fs.statSync(outFile).size} bytes`);
