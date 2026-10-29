import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

// Execute the actual shell entrypoint with a closed PATH. Every account,
// package-manager, download, service and Node command is a harmless fixture.
// No VM, real NSS lookup, package installation or system account is touched.
function fixture(options={}){
  const root=mkdtempSync(join(tmpdir(),'dbtv-bootstrap-fixture-')),source=join(root,'source'),home=join(root,'managed'),bin=join(root,'bin'),log=join(root,'commands');
  mkdirSync(join(source,'scripts','tv'),{recursive:true});mkdirSync(join(home,'tools','node','bin'),{recursive:true});mkdirSync(bin);
  copyFileSync(new URL('../install.sh',import.meta.url),join(source,'scripts','install.sh'));
  writeFileSync(join(source,'package-lock.json'),'{}');writeFileSync(join(source,'scripts','tv.mjs'),'// fixture');writeFileSync(join(source,'scripts','tv','copy-source.mjs'),'// fixture');
  for(const name of ['dirname','realpath','mkdir'])symlinkSync('/usr/bin/'+name,join(bin,name));
  const stub=`#!/bin/bash
name="\${0##*/}"
printf '%s' "$name" >> "$FIXTURE_LOG"; printf ' <%s>' "$@" >> "$FIXTURE_LOG"; printf '\\n' >> "$FIXTURE_LOG"
case "$name" in
  uname) [[ "$1" == -s ]] && printf 'Linux\\n' || printf 'x86_64\\n' ;;
  id) printf '0\\n' ;;
  getent) if [[ "$1" == passwd ]]; then exit "\${PASSWD_STATUS:-2}"; else exit "\${GROUP_STATUS:-2}"; fi ;;
  node) if [[ "\${1:-}" == -v ]]; then printf 'v22.23.4\\n'; fi ;;
  apt-get|pkg|docker|proot-distro) exit 0 ;;
  *) printf 'Forbidden unexpected command: %s\\n' "$name" >&2; exit 90 ;;
esac
`;
  for(const name of ['uname','id','getent','node','apt-get','pkg','docker','proot-distro','curl','git','tar','mv','useradd','userdel','usermod','groupadd','groupdel','groupmod','kill','pkill','systemctl','runuser']){if(name==='getent'&&options.noGetent)continue;writeFileSync(join(bin,name),stub,{mode:0o755});}
  copyFileSync(join(bin,'node'),join(home,'tools','node','bin','node'));chmodSync(join(home,'tools','node','bin','node'),0o755);
  if(options.installed)writeFileSync(join(home,'deployment.json'),'{}');
  const args=['--home',home,'--yes','--port','8788',...(options.args||[])];
  const env={PATH:bin,HOME:join(root,'user-home'),FIXTURE_LOG:log,PASSWD_STATUS:String(options.passwd??2),GROUP_STATUS:String(options.group??2),...(options.termux?{PREFIX:'/data/data/com.termux/files/usr'}:{}),...(options.runtimeOnly?{DBTV_RUNTIME_ONLY:'1'}:{})};
  const result=spawnSync('/bin/bash',[join(source,'scripts','install.sh'),...args],{env,encoding:'utf8',timeout:10000});
  const commands=existsSync(log)?readFileSync(log,'utf8'):'';rmSync(root,{recursive:true,force:true});
  return {...result,commands};
}
const beforePackages=result=>assert.doesNotMatch(result.commands,/^(apt-get|pkg|node|curl|git|useradd|userdel|usermod|groupadd|groupdel|groupmod|kill|pkill|systemctl|runuser) /m);

test('native bootstrap defaults to dabiaotv and verifies both identities before apt/runtime',()=>{
  const result=fixture();assert.equal(result.status,0,result.stderr);
  assert.match(result.commands,/getent <passwd> <dabiaotv>/);assert.match(result.commands,/getent <group> <dabiaotv>/);
  assert.ok(result.commands.indexOf('getent <group>')<result.commands.indexOf('apt-get <update>'));
  assert.match(result.commands,/node .*<install>.*<--service-user> <dabiaotv>/);
});
test('native bootstrap forwards an explicit independent service user',()=>{
  const result=fixture({args:['--service-user','dbtv-app','--mode','native']});assert.equal(result.status,0,result.stderr);
  assert.match(result.commands,/getent <passwd> <dbtv-app>/);assert.match(result.commands,/getent <group> <dbtv-app>/);assert.match(result.commands,/<--service-user> <dbtv-app>/);
  assert.doesNotMatch(result.commands,/dabiaotv|^(userdel|usermod|kill|pkill) /m);
});
for(const database of ['passwd','group'])test(`existing ${database} is rejected before package install with no identity mutation`,()=>{
  const result=fixture({[database]:0,args:['--service-user','dbtv-app']});assert.notEqual(result.status,0);assert.match(result.stderr,/拒绝复用已有/);beforePackages(result);
});
for(const status of [1,3,127])for(const database of ['passwd','group'])test(`${database} lookup status ${status} fails closed instead of treating errors as absence`,()=>{
  const result=fixture({[database]:status});assert.notEqual(result.status,0);assert.match(result.stderr,/查询异常/);beforePackages(result);
});
test('missing getent fails closed before apt or runtime',()=>{const result=fixture({noGetent:true});assert.notEqual(result.status,0);assert.match(result.stderr,/缺少 getent/);beforePackages(result)});
for(const name of ['root','Root','UPPER','1user','-flag','two words','user/name','a'.repeat(32),''])test(`invalid service account ${JSON.stringify(name)} is rejected before installation`,()=>{
  const result=fixture({args:['--service-user',name]});assert.notEqual(result.status,0);assert.match(result.stderr,/服务账号必须匹配/);beforePackages(result);assert.doesNotMatch(result.commands,/getent/);
});
test('missing service-user value is rejected',()=>{const result=fixture({args:['--service-user']});assert.notEqual(result.status,0);assert.match(result.stderr,/缺少账号名/);beforePackages(result)});
for(const mode of ['docker','termux'])test(`${mode} rejects an explicit service user before any installation command`,()=>{
  const result=fixture({args:['--mode',mode,'--service-user','dbtv-app'],termux:mode==='termux'});assert.notEqual(result.status,0);assert.match(result.stderr,/仅支持 native/);beforePackages(result);
});
test('Docker without service-user does not query native accounts or forward a default service-user',()=>{
  const result=fixture({args:['--mode','docker'],passwd:0,group:0});assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.commands,/getent|--service-user/);assert.match(result.commands,/docker <compose> <version>/);
});
test('Termux without service-user does not query native accounts or forward a default service-user',()=>{
  const result=fixture({termux:true,passwd:0,group:0});assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.commands,/getent|--service-user/);assert.match(result.commands,/pkg <update>/);
});
test('existing deployment is delegated to manager status path without rejecting its existing account',()=>{
  const result=fixture({installed:true,passwd:0,group:0,args:['--service-user','dbtv-app']});assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.commands,/getent|copy-source\.mjs/);assert.match(result.commands,/node .*\/source\/scripts\/tv\.mjs> <install>.*<--service-user> <dbtv-app>/);
});
test('the internal Termux runtime-only call does not apply native identity provisioning checks',()=>{
  const result=fixture({runtimeOnly:true,passwd:0,group:0});assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.commands,/getent|apt-get|<install>/);assert.match(result.commands,/node <-v>/);
});
test('help documents native-only service identity selection',()=>{const result=fixture({args:['--help']});assert.equal(result.status,0);assert.match(result.stdout,/--service-user dabiaotv/);assert.match(result.stdout,/仅用于 native/);beforePackages(result)});
