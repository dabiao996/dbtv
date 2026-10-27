import {useEffect, useRef, useState, type RefObject} from 'react';
import {captureCenterCrop, downloadVerifiedModel, inferCrop, X4PLUS_CROP_EDGE, X4PLUS_MODEL_BYTES} from './realesrgan-x4plus';
import './ai-enhancer.css';

type Preview = {source: string; crop: string; output: string; inferenceMs: number; theoreticalFps: number};

export default function AIEnhancer({videoRef}: {videoRef: RefObject<HTMLVideoElement | null>}) {
  const originalRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const activeRef = useRef(false);
  const previewRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState('默认原画；x4plus 仅对暂停帧中央区域做单帧预览');
  const compatible = window.isSecureContext && 'gpu' in navigator;

  function clear(message: string) {
    generationRef.current++;
    controllerRef.current?.abort();
    controllerRef.current = null;
    previewRef.current = false;
    setPreview(null);
    setStatus(activeRef.current ? `${message}；正在等待当前推理结束` : message);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => clear('视频已继续播放；单帧预览关闭，播放原画');
    const onSeek = () => {
      if (activeRef.current || previewRef.current) clear('视频定位后预览已失效；播放原画');
    };
    const onPiP = () => clear('画中画只播放原画');
    const onCast = () => clear('投屏只播放原画');
    const onNativeFullscreen = () => clear('原生全屏只播放原画');
    video.addEventListener('play', onPlay);
    video.addEventListener('seeking', onSeek);
    video.addEventListener('resize', onSeek);
    video.addEventListener('enterpictureinpicture', onPiP);
    video.addEventListener('webkitbeginfullscreen', onNativeFullscreen);
    video.remote?.addEventListener('connect', onCast);
    return () => {
      generationRef.current++;
      controllerRef.current?.abort();
      video.removeEventListener('play', onPlay);
      video.removeEventListener('seeking', onSeek);
      video.removeEventListener('resize', onSeek);
      video.removeEventListener('enterpictureinpicture', onPiP);
      video.removeEventListener('webkitbeginfullscreen', onNativeFullscreen);
      video.remote?.removeEventListener('connect', onCast);
    };
  }, [videoRef]);

  async function makePreview() {
    if (activeRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    if (!compatible) {setStatus('此浏览器缺少安全上下文或 WebGPU，继续播放原画'); return;}
    let crop;
    try {crop = captureCenterCrop(video);}
    catch (error) {setStatus(error instanceof Error ? error.message : '无法读取视频帧，继续播放原画'); return;}
    clear('准备加载模型…');
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    activeRef.current = true;
    setBusy(true);
    setStatus(`正在从本机加载并校验 x4plus 模型（${Math.round(X4PLUS_MODEL_BYTES / 1048576)} MiB）… 0%`);
    try {
      let lastPercent = -1;
      const model = await downloadVerifiedModel(controller.signal, percent => {
        if (generation === generationRef.current && percent !== lastPercent) {
          lastPercent = percent;
          setStatus(`正在从本机加载并校验 x4plus 模型（${Math.round(X4PLUS_MODEL_BYTES / 1048576)} MiB）… ${percent}%`);
        }
      });
      if (controller.signal.aborted || generation !== generationRef.current) return;
      setStatus(`模型校验通过；正在用 WebGPU 推理 ${crop.size}×${crop.size} 原生画面区域…`);
      const result = await inferCrop(crop, model, controller.signal, () => {
        if (generation === generationRef.current) clear('GPU 设备丢失，已恢复原画');
      });
      if (controller.signal.aborted || generation !== generationRef.current) return;
      const original = originalRef.current;
      const enhanced = resultRef.current;
      if (!original || !enhanced) throw new Error('无法显示模型结果');
      original.width = original.height = crop.size;
      enhanced.width = enhanced.height = crop.size * 4;
      original.getContext('2d')?.putImageData(crop.pixels, 0, 0);
      enhanced.getContext('2d')?.putImageData(result.image, 0, 0);
      const theoreticalFps = 1000 / result.inferenceMs;
      previewRef.current = true;
      setPreview({source: `${video.videoWidth}×${video.videoHeight}`, crop: `${crop.size}×${crop.size} @ (${crop.x},${crop.y})`, output: `${crop.size * 4}×${crop.size * 4}`, inferenceMs: result.inferenceMs, theoreticalFps});
      setStatus('x4plus 已完成一帧；下方 A/B 为同一区域、同样显示尺寸。视频仍播放原画。');
    } catch (error) {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setPreview(null);
        setStatus(error instanceof Error ? `${error.message}；继续播放原画` : 'x4plus 运行失败，继续播放原画');
      }
    } finally {
      activeRef.current = false;
      if (generation === generationRef.current) controllerRef.current = null;
      setBusy(false);
      if (generation !== generationRef.current) setStatus(current => current.replace('；正在等待当前推理结束', ''));
    }
  }

  return <>
    <div className="ai-enhancer-ui">
      <div className="ai-enhancer-buttons">
        <span className="ai-mode-title">AI画质增强（实验）</span>
        <button type="button" onClick={() => void makePreview()} disabled={busy || !compatible}>x4plus 单帧预览</button>
        {(busy || preview) && <button type="button" onClick={() => clear('已关闭预览，播放原画')}>关闭并看原画</button>}
      </div>
      <output role="status">{compatible ? status : '此浏览器缺少安全上下文或 WebGPU，播放原画'}</output>
      <small className="ai-enhancer-note">只处理暂停帧中央最多 {X4PLUS_CROP_EDGE}×{X4PLUS_CROP_EDGE} 原生像素；不是整段视频增强，不上传画面。</small>
    </div>
    <section className="ai-preview-panel" aria-label="x4plus 单帧 A/B 对比" hidden={!preview}>
      <div className="ai-preview-images">
        <figure><figcaption>原画 A</figcaption><canvas ref={originalRef} aria-label="原画中央区域"/></figure>
        <figure><figcaption>x4plus B</figcaption><canvas ref={resultRef} aria-label="模型处理后的相同区域"/></figure>
      </div>
      {preview && <p>源 {preview.source} · 原生裁切 {preview.crop} → 模型输出 {preview.output}。单帧推理 {Math.round(preview.inferenceMs)} ms；理论上限 {preview.theoreticalFps.toFixed(1)} 帧/秒，未验证连续实时。掉帧：不适用（暂停单帧）。</p>}
    </section>
  </>;
}
