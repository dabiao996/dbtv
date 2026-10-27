import type {Express} from 'express';
import {createHash} from 'node:crypto';
import {backfillMemberNumbers,ensureMemberNumber,createAccount,accountSearchWhere,validPassword} from './identity.js';
import {readContentRules,validateContentRules,readCategoryRules} from './content-policy.js';

export const permissionLabels:Record<string,string>={home:'浏览首页',sources:'浏览片库与分类',search:'全站搜索',playback:'影视详情与播放',favorites:'收藏管理',history:'观看历史',recommendations:'个性化推荐',discover:'评分与热门榜',danmaku:'查看及发送弹幕'};
export const permissionKeys=Object.keys(permissionLabels);
export const FREE_PLAN='free';
const MAX_POINTS=1_000_000_000,DAY=86400000;
class MembershipError extends Error {constructor(public status:number,message:string){super(message);}}
const reject=(status:number,message:string):never=>{throw new MembershipError(status,message)};
const digest=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const strings=(value:string)=>{try{const rows=JSON.parse(value);return Array.isArray(rows)?rows.filter(x=>typeof x==='string'):[]}catch{return []}};

export function permissionForApi(path:string,method='GET'):string|null{
  if(/^\/api\/live(\/|$)/.test(path))return 'playback';
  if(/^\/api\/sources\/[^/]+\/search\/?$/.test(path))return 'search';
  if(/^\/api\/sources\/[^/]+\/videos\/[^/]+\/?$/.test(path)||/^\/api\/(playback-options|play|playback-errors)(\/|$)/.test(path))return 'playback';
  if(/^\/api\/(sources|library)(\/|$)/.test(path))return 'sources';
  if(/^\/api\/search(\/|$)/.test(path))return 'search';
  if(/^\/api\/(catalog|discover)(\/|$)/.test(path))return 'discover';
  if(/^\/api\/recommendations(\/|$)/.test(path))return 'recommendations';
  if(/^\/api\/favorites(\/|$)/.test(path))return 'favorites';
  if(/^\/api\/history(\/|$)/.test(path))return method==='POST'?'playback':'history';
  if(/^\/api\/danmaku(\/|$)/.test(path))return 'danmaku';
  return null;
}

export function effectiveMembership(user:any,free:any,now=new Date(),groups:any[]=[]){
  const active=!!(user.membershipPlan?.enabled&&user.membershipPlanId!==FREE_PLAN&&user.membershipExpiresAt&&new Date(user.membershipExpiresAt)>now);
  const plan=active?user.membershipPlan:free;
  const admin=user.role==='admin';
  const contentRules=admin?readContentRules(null):readContentRules(plan.contentRules);
  // New simplified editor makes the grade's visible selection authoritative.
  // Existing plans keep their previous grants until an administrator explicitly saves them.
  const selectedOnly=contentRules.sourceSelection==='grade';
  const direct=selectedOnly?[]:user.sourceAccess.map((x:any)=>x.sourceKey);
  const ids=new Set([...selectedOnly?[]:strings(user.accessGroupIds),...strings(plan.accessGroupIds)]);
  const granted=groups.filter(group=>group.enabled&&ids.has(group.id));
  const unrestricted=new Set([...direct,...strings(plan.sourceKeys)]),sourceScopes:Record<string,any[]>={};
  for(const group of granted)for(const key of strings(group.sourceKeys)){
    const scope=readCategoryRules(group.categoryRules).filter(rule=>rule.sourceKey==='*'||rule.sourceKey===key);
    if(!scope.length)unrestricted.add(key);else sourceScopes[key]=[...(sourceScopes[key]||[]),...scope];
  }
  for(const key of unrestricted)delete sourceScopes[key];
  if(admin||plan.allSources)for(const key of Object.keys(sourceScopes))delete sourceScopes[key];
  return {permissions:admin?permissionKeys:strings(plan.permissions).filter(x=>permissionKeys.includes(x)),allSources:admin||!!plan.allSources,contentRules,sourceScopes,
    sourceKeys:[...new Set([...direct,...strings(plan.sourceKeys),...granted.flatMap(group=>strings(group.sourceKeys))])].filter(key=>!contentRules.deniedSourceKeys.includes(key as string)) as string[],
    membership:{planId:plan.id,name:admin?'管理员（不受会员限制）':plan.name,active,expiresAt:user.membershipExpiresAt||null,expired:!!(user.membershipPlanId&&user.membershipExpiresAt&&new Date(user.membershipExpiresAt)<=now)}};
}

export function createMembershipService(db:any,clock=()=>new Date()){
  let initialized:Promise<any>|undefined;
  function ready(){return initialized||=(db.membershipPlan.upsert({where:{id:FREE_PLAN},update:{},create:{id:FREE_PLAN,name:'普通用户',description:'默认保留现有页面功能；源访问沿用账号授权。管理员可调整此等级。',enabled:true,pricePoints:0,durationDays:0,permissions:JSON.stringify(permissionKeys),sourceKeys:'[]',allSources:false}}).then(()=>backfillMemberNumbers(db)).catch((error:any)=>{initialized=undefined;throw error}));}
  async function hydrate(user:any){
    await ready();
    const [free,groups]=await Promise.all([db.membershipPlan.findUnique({where:{id:FREE_PLAN}}),db.accessGroup.findMany({where:{enabled:true}})]);
    const access=effectiveMembership(user,free,clock(),groups);
    const memberNo=user.memberNo||await ensureMemberNumber(db,user.id);
    const sourceKeys=access.allSources?(await db.source.findMany({select:{key:true}})).map((x:any)=>x.key).filter((key:string)=>!access.contentRules.deniedSourceKeys.includes(key)):access.sourceKeys;
    return {...user,...access,memberNo,accessAllSources:access.allSources,sourceAccess:sourceKeys.map((sourceKey:string)=>({sourceKey})),pageAccess:access.permissions.join(',')};
  }
  const summary=(user:any)=>({id:user.id,memberNo:user.memberNo,username:user.username,displayName:user.displayName,avatarUrl:user.avatarUrl,role:user.role,enabled:user.enabled,points:user.points,pageAccess:user.pageAccess,permissions:user.permissions,contentRules:user.contentRules,sourceKeys:user.accessAllSources&&!readContentRules(user.contentRules).deniedSourceKeys.length?['*']:user.sourceAccess.map((x:any)=>x.sourceKey),membership:user.membership});
  async function wallet(user:any){await ready();const [storedPlans,ledger,groups]=await Promise.all([db.membershipPlan.findMany({where:{enabled:true,id:{not:FREE_PLAN}},orderBy:[{pricePoints:'asc'},{id:'asc'}]}),db.pointLedger.findMany({where:{userId:user.id},orderBy:[{createdAt:'desc'},{id:'desc'}],take:100}),db.accessGroup.findMany({where:{enabled:true}})]);const plans=storedPlans.map((plan:any)=>{const access=effectiveMembership({role:'user',sourceAccess:[],membershipPlanId:plan.id,membershipPlan:plan,membershipExpiresAt:new Date(clock().getTime()+86400000)},plan,clock(),groups);return {...plan,permissions:JSON.stringify(access.permissions),sourceKeys:JSON.stringify(access.sourceKeys)}});return {account:summary(user),plans,ledger,permissionLabels,payment:{enabled:false,message:'暂未接入在线支付。积分由管理员赠送或调整，本页仅支持积分兑换会员。'}};}
  function planInput(body:any,isFree=false){
    const name=typeof body.name==='string'?body.name.trim():'';
    const description=typeof body.description==='string'?body.description.trim():'';
    if(name.length<1||name.length>40||description.length>500)reject(400,'名称需为1–40字，说明最多500字');
    if(!Array.isArray(body.permissions)||body.permissions.some((x:any)=>!permissionKeys.includes(x)))reject(400,'权限选项无效');
    if(!Array.isArray(body.sourceKeys)||body.sourceKeys.length>500||body.sourceKeys.some((x:any)=>typeof x!=='string'||x.length>191))reject(400,'数据源授权无效');
    if(typeof body.allSources!=='boolean'||typeof body.enabled!=='boolean')reject(400,'启用状态和源授权选项无效');
    if(!isFree&&(!Number.isInteger(body.pricePoints)||body.pricePoints<1||body.pricePoints>1_000_000||!Number.isInteger(body.durationDays)||body.durationDays<1||body.durationDays>3650))reject(400,'套餐积分需为1–1000000，天数需为1–3650的整数');
    if(body.accessGroupIds!==undefined&&body.accessGroupIds!==null&&(!Array.isArray(body.accessGroupIds)||body.accessGroupIds.length>30||body.accessGroupIds.some((id:any)=>typeof id!=='string'||id.length>191)))reject(400,'授权分组无效');
    let contentRules:string|undefined;
    if(body.contentRules!==undefined){try{const raw=typeof body.contentRules==='string'?JSON.parse(body.contentRules):body.contentRules;contentRules=JSON.stringify(validateContentRules(raw===null?readContentRules(null):raw))}catch{reject(400,'内容限制或分类规则无效')}}
    return {name,description,pricePoints:isFree?0:body.pricePoints,durationDays:isFree?0:body.durationDays,enabled:isFree?true:body.enabled,permissions:JSON.stringify([...new Set(body.permissions)]),sourceKeys:JSON.stringify([...new Set(body.sourceKeys)]),allSources:body.allSources,...contentRules===undefined?{}:{contentRules},...body.accessGroupIds===undefined?{}:{accessGroupIds:JSON.stringify([...new Set(body.accessGroupIds||[])])}};
  }
  async function savePlan(actor:any,id:string|undefined,body:any){
    if(actor.role!=='admin')reject(403,'需要管理员权限');await ready();
    const data=planInput(body,id===FREE_PLAN);
    const count=await db.source.count({where:{key:{in:strings(data.sourceKeys)}}});if(count!==strings(data.sourceKeys).length)reject(400,'包含不存在的数据源');
    if(data.accessGroupIds!==undefined)await validateGroups(strings(data.accessGroupIds));
    if(data.contentRules){const rules=readContentRules(data.contentRules),keys=[...new Set([...rules.deniedSourceKeys,...rules.deniedCategories.map(rule=>rule.sourceKey).filter(key=>key!=='*')])];if(await db.source.count({where:{key:{in:keys}}})!==keys.length)reject(400,'限制规则包含不存在的数据源');}
    return db.$transaction(async(tx:any)=>{
      let plan;
      if(id){
        if(!Number.isInteger(body.version))reject(400,'缺少版本号，请刷新后重试');
        const saved=await tx.membershipPlan.updateMany({where:{id,version:body.version},data:{...data,version:{increment:1}}});
        if(!saved.count)reject(409,'套餐已被其他操作修改，请刷新后重试');
        plan=await tx.membershipPlan.findUnique({where:{id}});
      }else plan=await tx.membershipPlan.create({data});
      await tx.adminLog.create({data:{userId:actor.id,action:'membership.plan.save',detail:JSON.stringify({id:plan.id,name:plan.name,enabled:plan.enabled})}});
      return plan;
    });
  }
  async function validateGroups(ids:any){
    if(!Array.isArray(ids)||ids.length>30||ids.some(id=>typeof id!=='string'||id.length>191))reject(400,'授权分组无效');
    const unique=[...new Set<string>(ids)];if(await db.accessGroup.count({where:{id:{in:unique}}})!==unique.length)reject(400,'包含不存在的授权分组');return unique;
  }
  async function saveGroup(actor:any,id:string|undefined,body:any){
    if(actor.role!=='admin')reject(403,'需要管理员权限');
    const name=typeof body.name==='string'?body.name.trim():'',description=typeof body.description==='string'?body.description.trim():'';
    if(!name||name.length>40||description.length>500||typeof body.enabled!=='boolean')reject(400,'请填写1–40字分组名及有效状态，说明最多500字');
    if(!Array.isArray(body.sourceKeys)||body.sourceKeys.length>500||body.sourceKeys.some((key:any)=>typeof key!=='string'||key.length>191))reject(400,'分组数据源无效');
    const sourceKeys=[...new Set<string>(body.sourceKeys)];
    if(await db.source.count({where:{key:{in:sourceKeys}}})!==sourceKeys.length)reject(400,'包含不存在的数据源');
    // Groups organize sources only; page functionality is controlled by the membership plan.
    let categoryRules:any[]|undefined;
    if(body.categoryRules!==undefined){try{const raw=typeof body.categoryRules==='string'?JSON.parse(body.categoryRules):body.categoryRules;categoryRules=validateContentRules({deniedSourceKeys:[],deniedCategories:raw||[]}).deniedCategories;if(categoryRules.some(rule=>rule.sourceKey!=='*'&&!sourceKeys.includes(rule.sourceKey)))reject(400,'分类规则的源必须先加入此分组')}catch{reject(400,'分组分类规则无效，请先选中对应源')}}
    const data={name,description,enabled:body.enabled,permissions:'[]',sourceKeys:JSON.stringify(sourceKeys),...categoryRules===undefined?{}:{categoryRules:JSON.stringify(categoryRules)}};
    return db.$transaction(async(tx:any)=>{
      let group;
      if(id){
        if(!Number.isInteger(body.version))reject(400,'请刷新分组后重试');
        const saved=await tx.accessGroup.updateMany({where:{id,version:body.version},data:{...data,version:{increment:1}}});if(!saved.count)reject(409,'分组已变更，请刷新后重试');
        group=await tx.accessGroup.findUnique({where:{id}});
        // Group edits change the effective offer; stale redemption confirmations must refresh.
        await tx.membershipPlan.updateMany({where:{accessGroupIds:{contains:JSON.stringify(id)}},data:{version:{increment:1}}});
      }else group=await tx.accessGroup.create({data});
      await tx.adminLog.create({data:{userId:actor.id,action:'access-group.save',detail:JSON.stringify({groupId:group.id,name,enabled:data.enabled})}});return group;
    });
  }
  async function transaction(operationKey:string,requestHash:string,operation:(tx:any)=>Promise<any>){
    for(let i=0;i<5;i++){
      try{return await db.$transaction(async(tx:any)=>{
        const old=await tx.pointLedger.findUnique({where:{operationKey}});
        if(old){if(old.requestHash!==requestHash)reject(409,'同一请求标识不能用于不同操作');return {ok:true,replayed:true,entry:old};}
        return operation(tx);
      },{isolationLevel:'Serializable',maxWait:5000,timeout:10000});}
      catch(error:any){
        if(error instanceof MembershipError)throw error;
        // Retrying an uncertain SQLite timeout is safe because every attempt
        // first checks the unique ledger operation key in the same transaction.
        if(!['P2034','P2028','P2002','P1008'].includes(error.code)||i===4)throw error;
        await new Promise(resolve=>setTimeout(resolve,30*(i+1)));
      }
    }
  }
  function requestKey(id:any,scope:string){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(id))reject(400,'缺少有效的幂等请求标识');return digest([scope,id]);}
  async function adjust(actor:any,userId:number,body:any){
    if(actor.role!=='admin')reject(403,'需要管理员权限');await ready();
    const delta=body.delta,reason=typeof body.reason==='string'?body.reason.trim():'';
    if(!Number.isInteger(userId)||userId<1||!Number.isInteger(delta)||!delta||Math.abs(delta)>1_000_000||reason.length<2||reason.length>120)reject(400,'积分必须为非零整数且不超过100万，并填写2–120字原因');
    const key=requestKey(body.requestId,`adjust:${actor.id}:${userId}`),hash=digest([delta,reason]);
    return transaction(key,hash,async tx=>{
      const target=await tx.user.findUnique({where:{id:userId}});if(!target)reject(404,'用户不存在');
      const balance=target.points+delta;if(balance<0||balance>MAX_POINTS)reject(400,'积分不足以扣减，或超过余额上限');
      const changed=await tx.user.updateMany({where:{id:userId,walletVersion:target.walletVersion},data:{points:balance,walletVersion:{increment:1}}});
      if(!changed.count)throw Object.assign(Error('retry'),{code:'P2034'});
      const entry=await tx.pointLedger.create({data:{userId,actorId:actor.id,operationKey:key,requestHash:hash,kind:delta>0?'admin_grant':'admin_adjust',delta,balanceAfter:balance,reason}});
      await tx.adminLog.create({data:{userId:actor.id,action:'points.adjust',detail:JSON.stringify({targetId:userId,delta,reason,ledgerId:entry.id})}});
      return {ok:true,replayed:false,entry};
    });
  }
  async function redeem(user:any,body:any){
    await ready();const planId=String(body.planId||'');
    if(!planId||planId===FREE_PLAN||planId.length>191||!Number.isInteger(body.expectedVersion))reject(400,'请选择有效套餐并刷新价格');
    const key=requestKey(body.requestId,`redeem:${user.id}`),hash=digest([planId,body.expectedVersion]);
    return transaction(key,hash,async tx=>{
      const now=clock(),target=await tx.user.findUnique({where:{id:user.id}}),plan=await tx.membershipPlan.findUnique({where:{id:planId}});
      if(!target?.enabled)reject(403,'账号不可用');
      if(!plan?.enabled||plan.id===FREE_PLAN||plan.pricePoints<1||plan.durationDays<1)reject(400,'套餐未上架或不可兑换');
      if(plan.version!==body.expectedVersion)reject(409,'套餐价格或权限已变化，请刷新后重新确认');
      if(target.points<plan.pricePoints)reject(400,'积分不足，请联系管理员获取积分');
      if(target.membershipExpiresAt&&new Date(target.membershipExpiresAt)>now&&target.membershipPlanId&&target.membershipPlanId!==planId)reject(409,'有效期内仅支持续费同一会员等级，暂不支持跨等级折算');
      const base=target.membershipPlanId===planId&&target.membershipExpiresAt&&new Date(target.membershipExpiresAt)>now?new Date(target.membershipExpiresAt):now;
      const expiresAfter=new Date(base.getTime()+plan.durationDays*DAY);if(expiresAfter.getTime()>now.getTime()+36500*DAY)reject(400,'会员有效期超过上限');
      const balance=target.points-plan.pricePoints;
      const changed=await tx.user.updateMany({where:{id:user.id,walletVersion:target.walletVersion,enabled:true,points:{gte:plan.pricePoints}},data:{points:balance,walletVersion:{increment:1},membershipPlanId:plan.id,membershipExpiresAt:expiresAfter}});
      if(!changed.count)throw Object.assign(Error('retry'),{code:'P2034'});
      const entry=await tx.pointLedger.create({data:{userId:user.id,operationKey:key,requestHash:hash,kind:'membership_redeem',delta:-plan.pricePoints,balanceAfter:balance,reason:`积分兑换：${plan.name}`,planId:plan.id,planName:plan.name,durationDays:plan.durationDays,expiresAfter}});
      return {ok:true,replayed:false,entry};
    });
  }
  return {ready,hydrate,summary,wallet,savePlan,saveGroup,validateGroups,adjust,redeem};
}

export function registerMembership(app:Express,db:any,auth:{requireUser:any;requireAdmin:any;hashPassword:any},service=createMembershipService(db)){
  const attempts=new Map<string,{at:number;count:number}>();
  function rate(key:string,max:number,window=60000){let row=attempts.get(key);if(!row||row.at+window<Date.now()){if(attempts.size>5000)attempts.clear();row={at:Date.now(),count:0};attempts.set(key,row);}if(++row.count>max)reject(429,'操作过于频繁，请稍后重试');}
  const run=(fn:any)=>async(req:any,res:any)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');try{if(['POST','PUT'].includes(req.method)&&!req.is('application/json'))reject(415,'请使用 JSON 请求');await fn(req,res)}catch(e:any){res.status(e instanceof MembershipError?e.status:e.code==='P2002'?409:503).json({error:e instanceof MembershipError?e.message:e.code==='P2002'?'账号或请求标识已存在':'会员服务暂时繁忙，请稍后重试'});}};
  app.get('/api/membership',run(async(req:any,res:any)=>{const u=await auth.requireUser(req,res);if(u)res.json(await service.wallet(u));}));
  app.post('/api/membership/redeem',run(async(req:any,res:any)=>{const u=await auth.requireUser(req,res);if(!u)return;rate(`redeem:${u.id}`,15);res.json(await service.redeem(u,req.body||{}));}));
  app.get('/api/admin/membership',run(async(req:any,res:any)=>{if(!await auth.requireAdmin(req,res))return;await service.ready();const [plans,sources,ledger,groups,totalUsers,activeMembers]=await Promise.all([db.membershipPlan.findMany({orderBy:[{createdAt:'asc'},{id:'asc'}]}),db.source.findMany({select:{key:true,name:true,enabled:true}}),db.pointLedger.findMany({orderBy:[{createdAt:'desc'},{id:'desc'}],take:100}),db.accessGroup.findMany({orderBy:{name:'asc'}}),db.user.count(),db.user.count({where:{membershipExpiresAt:{gt:new Date()},membershipPlan:{enabled:true}}})]);const ids=[...new Set<number>(ledger.flatMap((row:any)=>[row.userId,...row.actorId?[row.actorId]:[]]))];const users=await db.user.findMany({where:{id:{in:ids}},select:{id:true,memberNo:true,username:true,displayName:true,enabled:true,role:true,points:true,membershipPlanId:true,membershipExpiresAt:true}});res.json({plans,users,sources,ledger,groups,stats:{totalUsers,activeMembers,enabledPlans:plans.filter((plan:any)=>plan.id!==FREE_PLAN&&plan.enabled).length},permissionLabels});}));
  app.post('/api/admin/membership/plans',run(async(req:any,res:any)=>{const u=await auth.requireAdmin(req,res);if(u)res.status(201).json(await service.savePlan(u,undefined,req.body||{}));}));
  app.put('/api/admin/membership/plans/:id',run(async(req:any,res:any)=>{const u=await auth.requireAdmin(req,res);if(u)res.json(await service.savePlan(u,req.params.id,req.body||{}));}));
  app.post('/api/admin/membership/users/:id/points',run(async(req:any,res:any)=>{const u=await auth.requireAdmin(req,res);if(!u)return;rate(`grant:${u.id}`,40);res.json(await service.adjust(u,Number(req.params.id),req.body||{}));}));
  app.get('/api/admin/member-search',run(async(req:any,res:any)=>{
    if(!await auth.requireAdmin(req,res))return;await service.ready();const q=String(req.query.q||'').trim().slice(0,80),page=Math.max(1,Math.min(5000,Number(req.query.page)||1));if(!Number.isInteger(page))reject(400,'页码无效');
    const where=accountSearchWhere(q),[items,total]=await Promise.all([db.user.findMany({where,select:{id:true,memberNo:true,username:true,displayName:true,points:true,enabled:true,role:true},orderBy:{id:'desc'},skip:(page-1)*20,take:20}),db.user.count({where})]);res.json({items,total,page,pageSize:20,hasMore:page*20<total});
  }));
  app.get('/api/admin/access-groups',run(async(req:any,res:any)=>{if(!await auth.requireAdmin(req,res))return;const [groups,sources]=await Promise.all([db.accessGroup.findMany({orderBy:{name:'asc'}}),db.source.findMany({select:{key:true,name:true,enabled:true}})]);res.json({groups,sources,permissionLabels});}));
  app.post('/api/admin/access-groups',run(async(req:any,res:any)=>{const user=await auth.requireAdmin(req,res);if(user)res.status(201).json(await service.saveGroup(user,undefined,req.body||{}));}));
  app.put('/api/admin/access-groups/:id',run(async(req:any,res:any)=>{const user=await auth.requireAdmin(req,res);if(user)res.json(await service.saveGroup(user,req.params.id,req.body||{}));}));
  app.post('/api/auth/register',run(async(req:any,res:any)=>{
    rate(`register:${req.ip}`,5,900000);
    const enabled=await db.setting.findUnique({where:{key:'allowRegister'}});if(enabled?.value!=='true')reject(403,'暂未开放注册，请联系管理员创建账号');
    const username=typeof req.body?.username==='string'?req.body.username.trim():'';const password=typeof req.body?.password==='string'?req.body.password:'';
    if(!/^[a-zA-Z0-9_-]{3,32}$/.test(username)||!validPassword(password)||password!==req.body.confirmPassword)reject(400,'账号需为3–32位字母数字或下划线短横线，密码需为6–128位且两次一致');
    const user=await createAccount(db,{username,passwordHash:auth.hashPassword(password),role:'user',points:0});
    res.status(201).json({ok:true,id:user.id,memberNo:user.memberNo,message:'注册成功，请登录'});
  }));
  return service;
}
