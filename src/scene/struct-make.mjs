import {fields,field,varint} from './wire.mjs';
import {loadGiaProto} from 'genshin-ts/injector/proto';

// Structures (结构体): a named group of typed fields that server graphs use as one value (高级数据管理 in the editor).
// What the editor writes for one was read from a save before and after a creator made "Structure" (text, icon: string;
// count: integer) by hand (2026-11-17), checked against the official sample 字典与结构体 (three float fields):
//   group 6  the structure: its id (its own numbering, from 0x40400001), its fields (type, default, name, place from 1),
//            its name, 1, and a counter that is one past the last field place given (it grows when fields are edited);
//   group 2  nine node definitions numbered on from the highest definition id: Assemble, Split and Modify for server
//            graphs, then Assemble and Split for three kinds of client graph (concrete ids 1060 and 1061, the client's
//            type numbers). A pin named after the structure carries it; pins are numbered on from the highest pin
//            number the save's definitions use, as composite nodes' are.
// A graph uses the server Assemble node like a composite node: a node whose id is the definition's, its input pins
// naming the definition's (compositePinIndex), with no flow pins (see toStructNodes in adapter.mjs).
const BASE=1610612736,STRUCT_BASE=0x40400000;
// type: [server VarType, client VarType, VarBase class, the field number of a default in the structure record]
export const STRUCT_FIELD_TYPES={int:[3,3,'IntBase',13],float:[5,7,'FloatBase',15],string:[6,9,'StringBase',16]};
const CLIENT_KINDS=['BooleanFilter','Skills','CreationStatusDecision'];
const messages=(b,id)=>fields(b).filter(f=>f.id===id&&f.wire===2).map(f=>f.data);
const num=(b,id)=>{const f=b?fields(b).find(x=>x.id===id&&x.wire===0):undefined;return f?Number(f.value):0;};
const sub=(b,id)=>b?fields(b).find(f=>f.id===id&&f.wire===2)?.data:undefined;
const text=s=>Buffer.from(s,'utf8');

// The structures of a save: {id, name, fields:[{name, type, place}]}.
export function inspectStructs(payload){
  const codes=new Map(Object.entries(STRUCT_FIELD_TYPES).map(([t,[server]])=>[server,t]));
  return messages(payload,10).flatMap(s=>fields(s).filter(f=>f.id===6&&f.wire===2)).flatMap(g=>messages(g.data,1)).map(raw=>({
    id:num(raw,1),name:messages(raw,501)[0]?.toString('utf8')??'',
    fields:messages(raw,3).map(v=>({name:messages(v,5)[0]?.toString('utf8')??'',type:codes.get(num(v,502))??'type '+num(v,502),place:num(v,503)})),
    ...nodesOf(payload,num(raw,1))}));
}
// The server Assemble, Split and Modify nodes of a structure (kinds 1003-1005): each its definition id and its input
// and output pins' numbers, in order.
function nodesOf(payload,structId){
  const defs=messages(payload,10).flatMap(s=>fields(s).filter(f=>f.id===2&&f.wire===2)).flatMap(g=>messages(g.data,1));
  const of=(kind,at)=>{const raw=defs.find(r=>num(sub(sub(r,4),1),2)===20000&&num(sub(r,107),1)===kind&&num(sub(sub(r,107),at),1)===structId);
    return raw?{definitionId:num(sub(sub(raw,4),1),5),pins:messages(raw,102).map(p=>num(p,8)),outputs:messages(raw,103).map(p=>num(p,8)),outflows:messages(raw,101).map(p=>num(p,8))}:null;};
  return {assemble:of(1003,104),split:of(1004,105),modify:of(1005,106)};
}

// Custom variables that hold structures (read from a player template a creator set by hand, StructProbe, 2026-11-22):
// a list of a structure is type 26, a dictionary from integers to a structure type 27. Both name the structure in
// their type tag (a list {1: 26, 2: {1: 1, 2: id}}; a dictionary {1: 27, 2: {1: 1, 2: 1090519041, the same in every
// save, 502: 3 the key's type, 503: 25, 504: id}}) and keep their start values in field 36 / 37 of the value: a list
// {1: value..., 501: id}, a dictionary {501: key..., 502: value..., 503: 3, 504: 25, 505: id}, all keys first. A
// structure value is {1: 25, 2: {1: 25, 2: {1: 1, 2: id}}, 35: {1: field..., 501: id, 502: {2: 28, 4: a number of its
// own, found nowhere else in the save}}}, a field {1: type, 2: {1: type, 2: {}}, at: {1: value} ({} for 0 or ''), 501: name}.
// shortcut: integer keys, and lists / dictionaries only (no variable of one structure): what the probe holds.
const DICT_TAG=1090519041,STRUCT_VARIABLE_TYPES={structList:26,dict:27};
const f32=n=>{const b=Buffer.alloc(4);b.writeFloatLE(n);return b;};
const tagged=(code,inner=Buffer.alloc(0))=>Buffer.concat([field(1,0,code),field(2,2,inner)]);
const scalar=(type,x)=>!x?Buffer.alloc(0):type==='int'?field(1,0,BigInt.asUintN(64,BigInt(x))):type==='float'?field(1,5,f32(x)):field(1,2,text(x));
const FITS={int:x=>(typeof x==='number'||typeof x==='bigint')&&Number.isInteger(Number(x))&&Math.abs(Number(x))<=2147483647,float:Number.isFinite,string:x=>typeof x==='string'&&x.length<=40};
const SAYS={int:'a whole number within ±2147483647',float:'a number',string:'a text of at most 40 characters'};
function structValue(s,given,id,bad){
  if(!given||typeof given!=='object'||Array.isArray(given))bad('A structure value is an object of its fields: {'+s.fields.map(f=>f.name+': <'+f.type+'>').join(', ')+'}; a field left out is 0 or empty.');
  const unknown=Object.keys(given).filter(k=>!s.fields.some(f=>f.name===k));
  if(unknown.length)bad('The structure '+s.name+' has no field '+unknown.join(', ')+'.',{fields:s.fields.map(f=>f.name)});
  const one=f=>{const x=given[f.name],[code,,,at]=STRUCT_FIELD_TYPES[f.type];
    if(x!==undefined&&!FITS[f.type](x))bad('The field '+f.name+' of '+s.name+' takes '+SAYS[f.type]+'.',{value:x});
    return field(1,2,Buffer.concat([field(1,0,code),field(2,2,tagged(code)),field(at,2,scalar(f.type,x)),field(501,2,text(f.name))]));};
  return Buffer.concat([field(1,0,25),field(2,2,tagged(25,Buffer.concat([field(1,0,1),field(2,0,s.id)]))),
    field(35,2,Buffer.concat([...s.fields.map(one),field(501,0,s.id),field(502,2,Buffer.concat([field(2,0,28),field(4,0,id())]))]))]);
}
// The block of a variable {name, type: 'structList' | 'dict', struct: name, value}, without its record field.
// structs: inspectStructs of the save; id(): a fresh number for each structure value; bad(message, details) throws.
export function structVariableBlock(v,structs,id,bad){
  const type=STRUCT_VARIABLE_TYPES[v.type],s=structs.find(x=>x.name===v.struct);
  if(!s)bad('The save has no structure '+JSON.stringify(v.struct??null)+': a '+v.type+' variable names one (struct), made with scene_add_struct.',{structs:structs.map(x=>x.name)});
  if(s.fields.some(f=>!STRUCT_FIELD_TYPES[f.type]))bad('The structure '+s.name+' has a field of a kind this tool cannot write a value of.',{fields:s.fields});
  const tag=type===26?tagged(26,Buffer.concat([field(1,0,1),field(2,0,s.id)])):tagged(27,Buffer.concat([field(1,0,1),field(2,0,DICT_TAG),field(502,0,3),field(503,0,25),field(504,0,s.id)]));
  let body;
  if(type===26){
    const list=v.value??[];
    if(!Array.isArray(list))bad('A structList variable takes an array of structure values.');
    body=field(36,2,Buffer.concat([...list.map(x=>field(1,2,structValue(s,x,id,bad))),field(501,0,s.id)]));
  }else{
    const map=v.value??{};
    if(!map||typeof map!=='object'||Array.isArray(map))bad('A dict variable takes an object from whole-number keys to structure values: {"1": {...}, "2": {...}}.');
    const keys=Object.keys(map);
    if(keys.some(k=>!/^-?\d+$/.test(k)||!FITS.int(Number(k))))bad('A dict variable\'s keys are whole numbers within ±2147483647.',{keys});
    const values=keys.map(k=>structValue(s,map[k],id,bad));
    body=field(37,2,Buffer.concat([...keys.map(k=>field(501,2,Buffer.concat([field(1,0,3),field(2,2,tagged(3)),field(13,2,scalar('int',Number(k)))]))),
      ...values.map(b=>field(502,2,b)),field(503,0,3),field(504,0,25),field(505,0,s.id)]));
  }
  return Buffer.concat([field(2,2,text(v.name)),field(3,0,type),field(4,2,Buffer.concat([field(1,0,type),field(2,2,tag),body])),field(5,0,1),field(6,2,tag)]);
}
// A structure variable of a variable block: {type: 'structList' | 'dict', structId}, or null.
export function structVariableOf(block){
  const type=num(block,3),kind=Object.keys(STRUCT_VARIABLE_TYPES).find(k=>STRUCT_VARIABLE_TYPES[k]===type);
  if(!kind)return null;
  const inner=sub(sub(block,6),2);
  return {type:kind,structId:num(inner,type===26?2:504)};
}
// The structure variables of these names anywhere in the save (any template, placed entity or player slot): name ->
// {type: 26 | 27, structId}, or {conflict: true} when two of one name hold different things. Found by the bytes a
// variable block starts with ({2: name, 3: 26 | 27, 4: {1: type, 2: tag, ...}}), not by parsing the whole save.
export function structVariablesNamed(root,names){
  const found=new Map();
  for(const name of new Set(names)){
    const key=field(2,2,text(name));
    for(let at=root.indexOf(key);at>=0;at=root.indexOf(key,at+1)){
      const i0=at+key.length,type=root[i0+1];
      if(root[i0]!==0x18||(type!==26&&type!==27)||root[i0+2]!==0x22)continue;
      let len=0,shift=0,i=i0+3;
      for(;;){const b=root[i++];len+=(b&127)*2**shift;shift+=7;if(!(b&128)||shift>35)break;}
      let structId;try{structId=num(sub(sub(root.subarray(i,i+len),2),2),type===26?2:504);}catch{continue;}
      const seen=found.get(name);
      found.set(name,seen&&(seen.type!==type||seen.structId!==structId)?{...seen,conflict:true}:{type,structId});
    }
  }
  return found;
}
// Fresh numbers for structure values: one past the highest save-wide number (from 0x40000000) the save holds.
// shortcut: a byte scan for 5-byte varints (0x40000000-0x403fffff) right after a varint key, not a parse; it can only
// overshoot, which keeps the numbers unique.
export function freshIds(root){
  let top=0x40000000;
  for(let i=1;i+4<root.length;i++)if((root[i-1]&7)===0&&root[i]&128&&root[i+1]&128&&root[i+2]&128&&(root[i+3]===128||root[i+3]===129)&&root[i+4]===4){
    const n=(root[i]&127)+(root[i+1]&127)*128+(root[i+2]&127)*16384+(root[i+3]&127)*2097152+0x40000000;if(n>top)top=n;}
  return ()=>++top;
}

// The record of group 6. list: [{name, type}]; counter: the editor's own (one past the last place, for a new one).
export function structRecord({id,name,list,counter=list.length+1}){
  const one=(f,i)=>{const [code,,,at]=STRUCT_FIELD_TYPES[f.type],kind=field(1,0,code);
    return field(3,2,Buffer.concat([field(1,2,Buffer.concat([kind,field(2,2,Buffer.alloc(0))])),
      field(3,2,Buffer.concat([kind,field(2,2,Buffer.concat([kind,field(2,2,Buffer.alloc(0))])),field(at,2,Buffer.alloc(0))])),
      field(5,2,text(f.name)),field(501,2,text(f.name)),field(502,0,code),field(503,0,i+1)]));};
  return Buffer.concat([field(1,0,id),...list.map(one),field(501,2,text(name)),field(502,0,1),field(503,0,counter)]);
}

// The nine definitions, in the editor's order. pin(): the next pin number; first: the first definition id.
export function structDefinitions({structId,name,list,first},pin){
  const Def=loadGiaProto().root.lookupType('CompositeDef'),kind=(t,f,i)=>({class:STRUCT_FIELD_TYPES[f.type][2],type1:STRUCT_FIELD_TYPES[f.type][t],type2:STRUCT_FIELD_TYPES[f.type][t]});
  const whole=t=>({class:'StructBase',type1:t?22:25,type2:t?22:25,valueId:{id:structId}}),at=(k,i)=>({kind:k,...(i?{index:i}:{})});
  const def=(n,type,concrete,body)=>{const id={class:'SystemDefined',type,kind:'SysGraph',id:first+n};
    const made=body(),tail=made.type.kind==='Modify'?3:4,bytes=Def.encode(Def.fromObject({id:{genericId:id,concreteId:concrete?{class:'SystemDefined',type,kind:'SysCall',id:concrete}:{...id},graphId:{}},...made})).finish();
    // Fields the pinned protocol lacks, written as the editor writes them: a mark {1: m} as field 5 of a pin, before
    // its number (13 on a pin that carries the structure; on Modify also 16, 15, 14 on its other pins), {1: 1} as
    // field 101 of the type of Modify's yes/no pins, and field 204 of the definition, 4 on Assemble and Split, 3 on Modify.
    const extras=[...(made.inputs??[]),...(made.outputs??[])].map(p=>p.extra??{});let k=0;
    const pinned=(p,{mark,flag})=>Buffer.concat(fields(p).flatMap(f=>f.id===8&&mark?[field(5,2,field(1,0,mark)),f.raw]:f.id===4&&flag?[field(4,2,Buffer.concat([f.data,field(101,2,field(1,0,1))]))]:[f.raw]));
    return Buffer.concat([...fields(Buffer.from(bytes)).map(f=>f.id===102||f.id===103?field(f.id,2,pinned(f.data,extras[k++])):f.raw),field(204,0,tail)]);};
  const data=(n,k,i,type,extra)=>({name:n,visible:true,index:at(k,i),type,pinIndex:pin(),...(extra?{extra}:{})});
  const assemble=t=>()=>{const inputs=list.map((f,i)=>data(f.name,'InParam',i,kind(t?1:0,f)));return {inputs,outputs:[data(name,'OutParam',0,whole(t),{mark:13})],type:{kind:'Assembly',assemble:{id:structId}},name:'Assemble Structure',xxx:5};};
  const split=t=>()=>{const inputs=[data(name,'InParam',0,whole(t),{mark:13})];return {inputs,outputs:list.map((f,i)=>data(f.name,'OutParam',i,kind(t?1:0,f))),type:{kind:'Split',split:{id:structId}},name:'Split Structure',xxx:5};};
  const modify=()=>{const inflows=[{visible:true,index:at('InFlow'),description:'',pinIndex:pin()}],outflows=[{visible:true,index:at('OutFlow'),description:'',pinIndex:pin()}];
    const inputs=[data(name,'InParam',0,whole(0),{mark:13}),{name:'Modify Object',type:{},pinIndex:pin(),extra:{mark:16}},
      ...list.flatMap((f,i)=>[data(f.name,'InParam',1+2*i,kind(0,f),{mark:15}),data('是否设置_'+f.name,'InParam',2+2*i,{class:'EnumBase',type2:'Boolean'},{mark:14,flag:true})])];
    return {inflows,outflows,inputs,type:{kind:'Modify',modify:{id:structId}},name:'Modify Structure',xxx:1};};
  return [def(0,'BasicNode',0,assemble(0)),def(1,'BasicNode',0,split(0)),def(2,'BasicNode',0,modify),
    ...CLIENT_KINDS.flatMap((type,i)=>[def(3+2*i,type,1060,assemble(1)),def(4+2*i,type,1061,split(1))])];
}

// section: the bytes of the save's section 10. Gives the section with the structure and its nodes added.
export function makeStruct(section,{name,list},fail){
  const parts=fields(section),known=inspectStructs(field(10,2,section));
  if(known.some(s=>s.name===name))fail('DUPLICATE_STRUCT_NAME','The save already has a structure of this name.',{name,structs:known.map(s=>s.name)});
  const defs=parts.filter(f=>f.id===2&&f.wire===2).flatMap(part=>messages(part.data,1));
  let serial=0;for(const raw of defs)for(const pin of fields(raw).filter(f=>f.wire===2&&f.id>=100&&f.id<=106))serial=Math.max(serial,num(pin.data,8));
  const first=Math.max(BASE,...defs.map(raw=>num(sub(sub(raw,4),1),5)))+1,structId=Math.max(STRUCT_BASE,...known.map(s=>s.id))+1;
  const made=structDefinitions({structId,name,list,first},()=>++serial).map(b=>field(2,2,field(1,2,b))),record=field(6,2,field(1,2,structRecord({id:structId,name,list})));
  const out=parts.map(f=>f.raw),lastDef=parts.findLastIndex(f=>f.id===2&&f.wire===2),lastStruct=parts.findLastIndex(f=>f.id===6&&f.wire===2);
  // The structure after the last structure (or at the end, after the signals' register); the nodes after the last definition.
  out.splice(lastStruct<0?out.length:lastStruct+1,0,record);
  out.splice(lastDef+1,0,...made);
  return {section:Buffer.concat(out),report:{name,structId,fields:list.map((f,i)=>({...f,place:i+1})),assembleId:first,splitId:first+1,modifyId:first+2}};
}
