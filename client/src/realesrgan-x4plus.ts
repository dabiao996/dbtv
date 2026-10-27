import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import wasmModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';

export const X4PLUS_MODEL_BYTES = 67051647;
export const X4PLUS_MODEL_SHA256 = '5e5264c2a9343f4c87f3824a14a1b27c3762f8a5060fd44a3f31f33724694637';
export const X4PLUS_CROP_EDGE = 128;

export type Crop = {pixels: ImageData; x: number; y: number; size: number};

export function captureCenterCrop(video: HTMLVideoElement): Crop {
  if (!video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw new Error('请先暂停视频，等待当前帧显示后再预览');
  const size = Math.min(X4PLUS_CROP_EDGE, video.videoWidth, video.videoHeight);
  if (size < 16) throw new Error('视频画面过小，无法进行模型预览');
  const x = Math.floor((video.videoWidth - size) / 2);
  const y = Math.floor((video.videoHeight - size) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context) throw new Error('浏览器无法读取视频帧');
  try {
    context.drawImage(video, x, y, size, size, 0, 0, size, size);
    return {pixels: context.getImageData(0, 0, size, size), x, y, size};
  } catch {
    throw new Error('视频画面不可读取（跨域 CORS 或受保护内容），继续播放原画');
  }
}

export async function downloadVerifiedModel(signal: AbortSignal, onProgress: (percent: number) => void): Promise<Uint8Array> {
  const response = await fetch(`${import.meta.env.BASE_URL}models/realesrgan/RealESRGAN_x4plus.onnx`, {signal, cache: 'force-cache'});
  if (!response.ok) throw new Error(`本机模型文件不可用（HTTP ${response.status}），继续播放原画`);
  const bytes = new Uint8Array(X4PLUS_MODEL_BYTES);
  let used = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (used + value.length > bytes.length) throw new Error('模型大小与已验证版本不符');
        bytes.set(value, used);
        used += value.length;
        onProgress(Math.round(used * 100 / bytes.length));
      }
    } finally {reader.releaseLock();}
  } else {
    const value = new Uint8Array(await response.arrayBuffer());
    if (value.length !== bytes.length) throw new Error('模型大小与已验证版本不符');
    bytes.set(value);
    used = value.length;
    onProgress(100);
  }
  if (used !== bytes.length) throw new Error('模型下载不完整，继续播放原画');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  if (hex !== X4PLUS_MODEL_SHA256) throw new Error('模型校验失败，继续播放原画');
  return bytes;
}

export async function inferCrop(crop: Crop, model: Uint8Array, signal: AbortSignal, onDeviceLost: () => void): Promise<{image: ImageData; inferenceMs: number}> {
  const ort = await import('onnxruntime-web/webgpu');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = {wasm: new URL(wasmUrl, location.href).href, mjs: new URL(wasmModuleUrl, location.href).href};
  if (signal.aborted) throw new DOMException('操作已取消', 'AbortError');
  const session = await ort.InferenceSession.create(model, {executionProviders: ['webgpu']});
  try {
    const device = await ort.env.webgpu.device;
    void device.lost.then(() => {if (!signal.aborted) onDeviceLost();});
    if (signal.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (session.inputNames.length !== 1 || session.inputNames[0] !== 'input' || session.outputNames[0] !== 'output') {
      throw new Error('模型输入输出与已验证结构不符');
    }
    const {size, pixels} = crop;
    const plane = size * size;
    const input = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i++) {
      input[i] = pixels.data[i * 4] / 255;
      input[plane + i] = pixels.data[i * 4 + 1] / 255;
      input[plane * 2 + i] = pixels.data[i * 4 + 2] / 255;
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
    const started = performance.now();
    const results = await session.run({input: tensor});
    const inferenceMs = performance.now() - started;
    const output = results.output;
    const edge = size * 4;
    if (!output || output.type !== 'float32' || output.dims.join(',') !== `1,3,${edge},${edge}`) {
      throw new Error('模型输出尺寸或格式异常');
    }
    const data = output.data as Float32Array;
    const image = new ImageData(edge, edge);
    const outputPlane = edge * edge;
    for (let i = 0; i < outputPlane; i++) {
      image.data[i * 4] = Math.round(Math.min(1, Math.max(0, data[i])) * 255);
      image.data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, data[outputPlane + i])) * 255);
      image.data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, data[outputPlane * 2 + i])) * 255);
      image.data[i * 4 + 3] = 255;
    }
    return {image, inferenceMs};
  } finally {await session.release();}
}
