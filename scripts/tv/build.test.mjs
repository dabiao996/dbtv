import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildDependencyArgs} from './build.mjs';

test('production build dependency install explicitly includes dev dependencies',()=>{
  assert.deepEqual(buildDependencyArgs(),['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund']);
  const mutated=buildDependencyArgs();mutated.push('--omit=dev');
  assert.ok(!buildDependencyArgs().includes('--omit=dev'),'each caller gets independent arguments');
});

test('initial install and update share the production build dependency policy',()=>{
  for(const relative of ['../tv.mjs','./update-driver.mjs']){
    const source=fs.readFileSync(new URL(relative,import.meta.url),'utf8');
    assert.match(source,/import\s*\{[^}]*\bbuildDependencyArgs\b[^}]*\}\s*from\s*['"][^'"]*build\.mjs['"]/);
    assert.match(source,/buildDependencyArgs\(\)/);
    assert.doesNotMatch(source,/['"]npm['"]\s*,\s*\[\s*['"]ci['"]/,'do not bypass the shared npm ci arguments');
  }
});
