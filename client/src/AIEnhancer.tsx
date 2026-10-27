import type {RefObject} from 'react';
import './ai-enhancer.css';

// Keep the ordinary player available while the replacement model is validated.
export default function AIEnhancer(_props: {videoRef: RefObject<HTMLVideoElement | null>}) {
  return <div className="ai-enhancer-ui">
    <div className="ai-enhancer-buttons"><span className="ai-mode-title">AI画质增强（实验）</span></div>
    <output role="status">旧模型已移除；RealESRGAN_x4plus 正在本机验证。当前播放原画。</output>
  </div>;
}
