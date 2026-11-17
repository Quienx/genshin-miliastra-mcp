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
    assemble:assembleOf(payload,num(raw,1))}));
}
// The server Assemble node of a structure: its definition id and its input pins' numbers, in order.
function assembleOf(payload,structId){
  const raw=messages(payload,10).flatMap(s=>fields(s).filter(f=>f.id===2&&f.wire===2)).flatMap(g=>messages(g.data,1))
    .find(r=>num(sub(sub(r,4),1),2)===20000&&num(sub(r,107),1)===1003&&num(sub(sub(r,107),104),1)===structId);
  return raw?{definitionId:num(sub(sub(raw,4),1),5),pins:messages(raw,102).map(p=>num(p,8))}:null;
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
