const base=(import.meta.env.VITE_API_URL||'')+'/api/admin/updates';
export async function requestUpdate(path='',body?:unknown,signal?:AbortSignal){
  const response=await fetch(base+path,{credentials:'include',cache:'no-store',signal,...body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}});
  const value=await response.json();
  if(!response.ok)throw Error(value.error||'版本检查请求失败');
  return value;
}
