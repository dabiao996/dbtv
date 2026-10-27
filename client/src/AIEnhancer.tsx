import {useEffect, useRef, useState} from 'react';
import {AIEnhancementSession, type EnhancementPreset, type EnhancementLevel, type EnhancementStatus} from './ai-enhancement';
import './ai-enhancer.css';

export default function AIEnhancer({videoRef}: {videoRef: React.RefObject<HTMLVideoElement | null>}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<AIEnhancementSession | null>(null);
  const [preset, setPreset] = useState<'original' | EnhancementPreset>('original');
  const [level, setLevel] = useState<EnhancementLevel>('standard');
  const [compare, setCompare] = useState(false);
  const [status, setStatus] = useState<EnhancementStatus>({active: false, message: '默认关闭；由此设备 GPU 本地处理'});
  const compatible = window.isSecureContext && 'gpu' in navigator && !!HTMLVideoElement.prototype.requestVideoFrameCallback;
  const enabled = preset !== 'original';

  useEffect(() => {
    if (preset === 'original') return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const aborter = new AbortController();
    const session = new AIEnhancementSession(video, canvas, result => {
      if (aborter.signal.aborted) return;
      setStatus(result);
      if (!result.active && result.message !== '定位中，暂时显示原画') setPreset('original');
    });
    sessionRef.current = session;
    let started = false;
    const start = () => {
      if (started || aborter.signal.aborted || video.readyState < 2) return;
      started = true;
      setStatus({active: false, message: `正在加载${preset === 'anime' ? '动画' : '真人'}模型和 WebGPU…`});
      void session.start(preset, level, aborter.signal).catch(error => {
        if (aborter.signal.aborted) return;
        session.stop();
        setStatus({active: false, message: error instanceof Error ? error.message : 'AI 增强初始化失败，已恢复原画'});
        setPreset('original');
      });
    };
    video.addEventListener('loadeddata', start);
    start();
    return () => {
      aborter.abort();
      video.removeEventListener('loadeddata', start);
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [preset, level, videoRef]);

  function changePreset(next: 'original' | EnhancementPreset) {
    if (preset === next) return;
    sessionRef.current?.stop();
    setCompare(false);
    setStatus({active: false, message: next === 'original' ? '已关闭，播放原画' : '正在检查设备和视频源…'});
    setPreset(next);
  }

  function changeLevel(next: EnhancementLevel) {
    if (level === next) return;
    sessionRef.current?.stop();
    setCompare(false);
    setLevel(next);
    setStatus({active: false, message: '正在切换模型…'});
  }

  async function toggleContainerFullscreen() {
    const shell = canvasRef.current?.parentElement;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell?.requestFullscreen) await shell.requestFullscreen();
      else setStatus({active: status.active, message: '此浏览器不能让播放器容器全屏；原生全屏会显示原画'});
    } catch {
      setStatus({active: status.active, message: '播放器容器全屏失败；原生全屏会显示原画'});
    }
  }

  const visible = enabled && status.active && !compare;
  return <>
    <canvas ref={canvasRef} className={`ai-enhanced-canvas ${visible ? 'is-visible' : ''}`} aria-hidden="true"/>
    <div className="ai-enhancer-ui">
      <div className="ai-enhancer-buttons">
        <span className="ai-mode-title">AI画质增强（实验）</span>
        <select aria-label="画质处理模式" value={preset} onChange={event => changePreset(event.target.value as 'original' | EnhancementPreset)} disabled={!compatible}>
          <option value="original">原画 · 默认关闭</option>
          <option value="anime">动画 · Anime4K CNN</option>
          <option value="real">真人 · WebSR 实验</option>
        </select>
        {enabled && <select aria-label="增强档位" value={level} onChange={event => changeLevel(event.target.value as EnhancementLevel)}>
          <option value="light">轻量 S</option><option value="standard">标准 M</option><option value="detail">高负载 L</option>
        </select>}
        {enabled && <button type="button" onClick={() => void toggleContainerFullscreen()}>播放器全屏</button>}
        {status.active && <button type="button" className="ai-compare" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerCancel={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onKeyDown={event => {if (event.key === ' ' || event.key === 'Enter') setCompare(true);}} onKeyUp={() => setCompare(false)}>按住看原画 A/B</button>}
      </div>
      <output role="status">{compatible ? status.message : '此浏览器缺少安全上下文、WebGPU 或视频帧回调，播放原画'}{status.sourceSize && status.outputSize && ` · 输入 ${status.sourceSize} → 模型输出 ${status.outputSize}`}{status.displaySize && ` → 播放窗口 ${status.displaySize}`}{status.displayUpscaled && ' · 播放窗口大于模型输出，浏览器仍会放大画面'}{status.frameMs !== undefined && ` · 平均帧耗时 ${status.frameMs}ms`}{status.droppedFrames !== undefined && ` · 启用后浏览器掉帧 ${status.droppedFrames}`}{compare && ' · A/B 正在显示原画'}</output>
      {enabled && <small className="ai-enhancer-note">{preset === 'real' ? '真人权重效果有限，L 只是更高负载实验；请按 A/B 判断是否值得开启。' : '动画使用 Anime4K 原始 CNN 权重；线条可能更明显，也可能出现光晕。'}若发热或卡顿，请切轻量档或原画。</small>}
    </div>
  </>;
}
