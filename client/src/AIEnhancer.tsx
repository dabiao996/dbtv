import {useCallback, useEffect, useRef, useState} from 'react';
import {AIEnhancementSession, type EnhancementLevel, type EnhancementStatus} from './ai-enhancement';
import './ai-enhancer.css';

export default function AIEnhancer({videoRef}: {videoRef: React.RefObject<HTMLVideoElement | null>}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<AIEnhancementSession | null>(null);
  const [preset, setPreset] = useState<'original' | 'anime'>('original');
  const [level, setLevel] = useState<EnhancementLevel>('standard');
  const [compare, setCompare] = useState(false);
  const [shellFullscreen, setShellFullscreen] = useState(false);
  const [status, setStatus] = useState<EnhancementStatus>({active: false, message: '默认关闭；由此设备 GPU 本地处理'});
  const compatible = window.isSecureContext && 'gpu' in navigator && !!HTMLVideoElement.prototype.requestVideoFrameCallback;
  const enabled = preset !== 'original';

  const toggleContainerFullscreen = useCallback(async () => {
    const shell = canvasRef.current?.parentElement;
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else if (shell?.requestFullscreen) await shell.requestFullscreen();
      else setStatus(previous => ({...previous, message: '此设备不支持播放器容器全屏；视频原生全屏无法显示增强画布'}));
    } catch {
      setStatus(previous => ({...previous, message: '播放器容器全屏失败；视频原生全屏无法显示增强画布'}));
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const shell = canvasRef.current?.parentElement;
    if (!video || !shell) return;
    const onDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      void toggleContainerFullscreen();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      void toggleContainerFullscreen();
    };
    const onFullscreenChange = () => setShellFullscreen(document.fullscreenElement === shell);
    video.addEventListener('dblclick', onDoubleClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      video.removeEventListener('dblclick', onDoubleClick);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [toggleContainerFullscreen, videoRef]);

  useEffect(() => {
    if (preset === 'original') return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const aborter = new AbortController();
    let ready = false;
    const session = new AIEnhancementSession(video, canvas, result => {
      if (aborter.signal.aborted) return;
      if (result.active) {ready = true; window.clearTimeout(timeout);}
      setStatus(result);
      if (!result.active && result.message !== '定位中，暂时显示原画') setPreset('original');
    });
    sessionRef.current = session;
    let started = false;
    const timeout = window.setTimeout(() => {
      if (!ready && !aborter.signal.aborted) {
        aborter.abort();
        session.stop();
        setStatus({active: false, message: started ? '模型初始化超时，已恢复原画；可切轻量档重试' : '视频帧长时间未就绪，已恢复原画；可在画面出现后重试'});
        setPreset('original');
      }
    }, 20000);
    const start = () => {
      if (started || aborter.signal.aborted || video.readyState < 2) return;
      started = true;
      setStatus({active: false, message: '正在加载动画模型和 WebGPU…'});
      void session.start(level, aborter.signal).catch(error => {
        if (aborter.signal.aborted) return;
        session.stop();
        setStatus({active: false, message: error instanceof Error ? error.message : 'AI 增强初始化失败，已恢复原画'});
        setPreset('original');
      });
    };
    const onMediaError = () => {
      if (aborter.signal.aborted || started) return;
      setStatus({active: false, message: '视频源无法解码，已恢复原画'});
      setPreset('original');
    };
    video.addEventListener('loadeddata', start);
    video.addEventListener('canplay', start);
    video.addEventListener('seeked', start);
    video.addEventListener('error', onMediaError);
    start();
    return () => {
      aborter.abort();
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', start);
      video.removeEventListener('canplay', start);
      video.removeEventListener('seeked', start);
      video.removeEventListener('error', onMediaError);
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [preset, level, videoRef]);

  function changePreset(next: 'original' | 'anime') {
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

  const visible = enabled && status.active && !compare;
  return <>
    <canvas ref={canvasRef} className={`ai-enhanced-canvas ${visible ? 'is-visible' : ''}`} aria-hidden="true"/>
    <div className="ai-enhancer-ui">
      <div className="ai-enhancer-buttons">
        <span className="ai-mode-title">AI画质增强（实验）</span>
        <select aria-label="画质处理模式" value={preset} onChange={event => changePreset(event.target.value as 'original' | 'anime')} disabled={!compatible}>
          <option value="original">原画 · 默认关闭</option>
          <option value="anime">动画 · Anime4K CNN</option>
        </select>
        {enabled && <select aria-label="增强档位" value={level} onChange={event => changeLevel(event.target.value as EnhancementLevel)}>
          <option value="light">轻量 S</option><option value="standard">标准 M</option><option value="detail">高负载 L</option>
        </select>}
        <button type="button" aria-label={shellFullscreen ? '退出播放器全屏' : '播放器全屏'} onClick={() => void toggleContainerFullscreen()}>{shellFullscreen ? '退出全屏' : '播放器全屏'}</button>
        {status.active && <button type="button" className="ai-compare" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerCancel={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onKeyDown={event => {if (event.key === ' ' || event.key === 'Enter') setCompare(true);}} onKeyUp={() => setCompare(false)}>按住看原画 A/B</button>}
      </div>
      <output role="status">{compatible ? status.message : '此浏览器缺少安全上下文、WebGPU 或视频帧回调，播放原画'}{status.sourceSize && status.outputSize && ` · 输入 ${status.sourceSize} → 模型输出 ${status.outputSize}`}{status.displaySize && ` → 播放窗口 ${status.displaySize}`}{status.displayUpscaled && ' · 播放窗口大于模型输出，浏览器仍会放大画面'}{status.frameMs !== undefined && ` · 平均帧耗时 ${status.frameMs}ms`}{status.droppedFrames !== undefined && ` · 启用后浏览器掉帧 ${status.droppedFrames}`}{compare && ' · A/B 正在显示原画'}</output>
      {enabled && <small className="ai-enhancer-note">双击画面或按 F 可让播放器全屏并保留增强。动画使用 Anime4K 原始 CNN 权重；线条可能更明显，也可能出现光晕。若发热或卡顿，请切轻量档或原画。</small>}
    </div>
  </>;
}
