import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {AIEnhancementSession, checkReadableFrame, MODELS} from '../src/ai-enhancement';

test('animation levels load the matching audited Anime4K weights', () => {
    for (const level of ['light', 'standard', 'detail'] as const) {
      const model = MODELS[level];
      const weights = JSON.parse(readFileSync(resolve('client/public/models/websr', model.file), 'utf8'));
      assert.equal(weights.name, model.network);
      assert.ok(Object.keys(weights.layers).length > 0);
      assert.match(model.file, /-an\.json$/);
    }
});

test('tainted video is rejected before model download or GPU work', async () => {
  const original = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    fetch: globalThis.fetch,
  };
  let downloads = 0;
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {isSecureContext: true}});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {gpu: {}}});
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => ({getContext: () => ({drawImage() {throw new Error('tainted');}, getImageData() {throw new Error('tainted');}})})}});
  globalThis.fetch = (async () => {downloads++; throw new Error('should not fetch');}) as typeof fetch;
  const video = {videoWidth: 320, videoHeight: 180, requestVideoFrameCallback() {}, cancelVideoFrameCallback() {}} as unknown as HTMLVideoElement;
  try {
    assert.throws(() => checkReadableFrame(video), /跨域或受保护内容/);
    const session = new AIEnhancementSession(video, {} as HTMLCanvasElement, () => {});
    await assert.rejects(session.start('light', new AbortController().signal), /跨域或受保护内容/);
    assert.equal(downloads, 0);
  } finally {
    for (const key of ['window', 'navigator', 'document'] as const) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
    globalThis.fetch = original.fetch;
  }
});
