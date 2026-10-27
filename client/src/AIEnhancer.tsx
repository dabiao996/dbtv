import {useEffect, useRef, useState} from 'react';
import {AIEnhancementSession, type EnhancementMode, type EnhancementStatus} from './ai-enhancement';
import './ai-enhancer.css';

export default function AIEnhancer({videoRef}: {videoRef: React.RefObject<HTMLVideoElement | null>}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<AIEnhancementSession | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<EnhancementMode>('light');
  const [compare, setCompare] = useState(false);
  const [status, setStatus] = useState<EnhancementStatus>({active: false, message: '默认关闭；由此设备 GPU 本地处理'});
  const compatible = window.isSecureContext && 'gpu' in navigator && !!HTMLVideoElement.prototype.requestVideoFrameCallback;

  useEffect(() => {
    if (!enabled) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const aborter = new AbortController();
    const session = new AIEnhancementSession(video, canvas, result => {
      if (aborter.signal.aborted) return;
      setStatus(result);
      if (!result.active && result.message !== '定位中，暂时显示原画') setEnabled(false);
    });
    sessionRef.current = session;
    let started = false;
    const start = () => {
      if (started || aborter.signal.aborted || video.readyState < 2) return;
      started = true;
      setStatus({active: false, message: '正在加载真人模型和 WebGPU…'});
      void session.start(mode, aborter.signal).catch(error => {
        if (aborter.signal.aborted) return;
        session.stop();
        setStatus({active: false, message: error instanceof Error ? error.message : 'AI 增强初始化失败，已恢复原画'});
        setEnabled(false);
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
  }, [enabled, mode, videoRef]);

  function toggle() {
    if (enabled) {
      sessionRef.current?.stop();
      setEnabled(false);
      setCompare(false);
      setStatus({active: false, message: '已关闭，播放原画'});
    } else {
      setStatus({active: false, message: '正在检查设备和视频源…'});
      setEnabled(true);
    }
  }

  function changeMode(next: EnhancementMode) {
    if (mode === next) return;
    sessionRef.current?.stop();
    setMode(next);
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
        <button type="button" aria-pressed={enabled} onClick={toggle} disabled={!compatible}>
          AI画质增强（实验）{enabled ? ' · 开' : ' · 关'}
        </button>
        {enabled && <select aria-label="AI增强档位" value={mode} onChange={event => changeMode(event.target.value as EnhancementMode)}>
          <option value="light">轻量 · 真人 S</option><option value="standard">标准 · 真人 M</option>
        </select>}
        {enabled && <button type="button" onClick={() => void toggleContainerFullscreen()}>播放器全屏</button>}
        {status.active && <button type="button" className="ai-compare" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerCancel={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onKeyDown={event => {if (event.key === ' ' || event.key === 'Enter') setCompare(true);}} onKeyUp={() => setCompare(false)}>按住看原画 A/B</button>}
      </div>
      <output role="status">{compatible ? status.message : '此浏览器缺少安全上下文、WebGPU 或视频帧回调，播放原画'}{status.frameMs !== undefined && ` · 平均帧耗时 ${status.frameMs}ms`}{status.droppedFrames !== undefined && ` · 浏览器累计掉帧 ${status.droppedFrames}`}</output>
    </div>
  </>;
}
