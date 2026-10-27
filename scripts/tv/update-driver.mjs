import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import releases from '../releases.cjs';
import {privateDirectory,health} from './core.mjs';

export function createDriver(home,adapter){
  const inspect=image=>{
    const value=adapter.execute('docker',['image','inspect','--format','{{json .}}',image],{capture:true});
    try{return JSON.parse(value.text);}catch{throw Error('无法验证本地镜像元数据');}
  };
  return {
    ready:async state=>{
      const value=await health(state),expected=state.release||releases.current(state.source);
      return adapter.processRunning(home,state)&&value.http&&value.database==='connected'&&value.installed===true&&value.version===expected.version&&value.dataContract===expected.dataContract&&(state.mode==='docker'||releases.dataContract(state.source)===expected.dataContract);
    },
    runningImage:async()=>{
      const container=adapter.docker(home,['ps','--quiet','dabiao-tv'],{capture:true}).text.trim();
      if(!/^[a-f0-9]{12,64}$/.test(container))throw Error('无法确定旧容器，拒绝在没有回退镜像时更新');
      const image=adapter.execute('docker',['container','inspect','--format','{{.Image}}',container],{capture:true}).text.trim();
      if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('旧镜像标识无效');inspect(image);return image;
    },
    prepare:async(state,remote)=>{
      const manifest=remote.manifest;
      if(state.mode==='docker'){
        adapter.execute('docker',['pull',manifest.image]);
        const image=inspect(manifest.image),labels=image.Config?.Labels||{};
        if(!image.RepoDigests?.includes(manifest.image)||labels['org.opencontainers.image.version']!==manifest.version||labels['io.dbtv.data-contract']!==manifest.dataContract)throw Error('新版镜像与签名清单不一致，旧站点保持运行');
        return {...state,image:manifest.image};
      }
      const directory=path.join(home,'releases',`${manifest.version}-${randomUUID().slice(0,8)}`),source=path.join(directory,'app');
      privateDirectory(directory);fs.mkdirSync(source,{mode:0o755});
      const archive=path.join(directory,'source.tar.gz');
      try{
        const bytes=await releases.download(manifest.source.url,{limit:32*1024*1024,timeout:120000});
        if(createHash('sha256').update(bytes).digest('hex')!==manifest.source.sha256)throw Error('源码校验失败，未停止旧站点');
        fs.writeFileSync(archive,bytes,{mode:0o600,flag:'wx'});
        const names=adapter.execute('tar',['-tzf',archive],{capture:true}).text.trim().split('\n');
        if(names.length>10000||names.some(name=>name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||/[\x00-\x1f]/.test(name)))throw Error('发行包包含不安全路径');
        const types=adapter.execute('tar',['-tvzf',archive],{capture:true}).text.trim().split('\n');
        if(types.some(line=>!/^[-d]/.test(line)))throw Error('发行包不允许符号链接、硬链接或设备文件');
        adapter.execute('tar',['-xzf',archive,'-C',source]);
        const selected=releases.current(source);
        if(selected.version!==manifest.version||selected.channel!=='stable'||releases.dataContract(source)!==manifest.dataContract||releases.publicKey(source)?.trim()!==adapter.key.trim())throw Error('源码版本、数据兼容标识或更新公钥与正式清单不符');
        const next={...state,source};
        fs.chmodSync(path.join(home,'releases'),0o755);fs.chmodSync(directory,0o755);
        if(state.mode==='native')adapter.execute('chown',['-R','dabiaotv:dabiaotv',directory]);
        adapter.application(home,next,next.node,[adapter.npmPath(next),'ci','--ignore-scripts','--no-audit','--no-fund']);
        adapter.application(home,next,next.node,[adapter.npmPath(next),'run','build']);
        if(releases.current(source).dataContract!==manifest.dataContract||releases.dataContract(source)!==manifest.dataContract)throw Error('构建期间源码发生变化，拒绝切换版本');
        adapter.application(home,next,next.node,[adapter.npmPath(next),'cache','clean','--force']);
        if(state.mode==='native'){
          adapter.execute('chown',['-R','root:root',directory]);adapter.execute('chmod',['-R','a+rX',directory]);
          for(const writable of ['.generated','node_modules'])adapter.execute('chown',['-R','dabiaotv:dabiaotv',path.join(source,writable)]);
        }
        return next;
      }finally{if(fs.existsSync(archive))fs.unlinkSync(archive);}
    },
    verifyPrevious:async state=>{
      if(state.mode==='docker'){if(!state.image)throw Error('旧镜像记录缺失');inspect(state.image);}
      else if(!fs.existsSync(path.join(state.source,'server/dist/index.js'))||releases.dataContract(state.source)!==state.release.dataContract)throw Error('旧程序文件已变化或缺失，拒绝回退');
    },
    stop:async state=>adapter.service(home,state,'stop'),
    persist:async state=>adapter.persist(home,state),
    start:async state=>adapter.service(home,state,'start'),
    healthy:async state=>{
      const value=await adapter.waitHealthy(home,state);
      if(state.release&&(value.version!==state.release.version||value.dataContract!==state.release.dataContract))throw Error('响应不是目标版本及数据兼容标识，禁止宣称更新成功');
    },
    permissions:async directory=>{
      if(adapter.mode==='native')adapter.execute('chown',['-R','dabiaotv:dabiaotv',directory]);
    }
  };
}
