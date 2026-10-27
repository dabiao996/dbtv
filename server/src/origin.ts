// Keep the API gate and update routes on the same browser-origin policy.
export function trustedBrowserOrigin(raw:unknown,host:string|undefined,appOrigin=process.env.APP_ORIGIN,nodeEnv=process.env.NODE_ENV):boolean {
  if(typeof raw!=='string')return false;
  try{
    const origin=new URL(raw);
    return origin.host===host||origin.origin===appOrigin||nodeEnv!=='production'&&
      /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host||'')&&/^https?:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin.origin);
  }catch{return false;}
}
