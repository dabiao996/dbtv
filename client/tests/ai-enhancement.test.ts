import test from 'node:test';
import assert from 'node:assert/strict';
import {AIEnhancementSession, checkReadableFrame} from '../src/ai-enhancement';

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
