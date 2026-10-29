export type GenerationRequest={count:number;requestId:string};
export const generationStorageKey='dbtv:virtual-uploaders:pending-generation';
export function readGenerationRequest(raw:string|null):GenerationRequest|null{
  try{const value=JSON.parse(raw||'null');return value&&Number.isInteger(value.count)&&value.count>=1&&value.count<=100&&typeof value.requestId==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId)?{count:value.count,requestId:value.requestId}:null}catch{return null}
}
export function nextGenerationRequest(pending:GenerationRequest|null,count:number,uuid:()=>string):GenerationRequest{
  if(pending)return pending;
  if(!Number.isInteger(count)||count<1||count>100)throw Error('每批请输入 1–100 个虚拟展示用户');
  return {count,requestId:uuid()};
}
