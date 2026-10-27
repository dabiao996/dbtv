import {useEffect, useRef, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import AIEnhancer from './AIEnhancer';
import './ai-lab.css';

function Lab() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => () => {if (url) URL.revokeObjectURL(url);}, [url]);
  function choose(file?: File) {
    if (!file) return;
    if (!file.type.startsWith('video/')) return;
    setUrl(URL.createObjectURL(file));
    setFileName(file.name);
    setSynthetic(false);
  }
  function makeSyntheticClip() {
    if (!('MediaRecorder' in window)) {setMessage('此浏览器无法录制合成测试片段'); return;}
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) {setMessage('无法创建合成测试画面'); return;}
    const stream = canvas.captureStream(24);
    const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const recorder = new MediaRecorder(stream, {mimeType: type});
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => {if (event.data.size) chunks.push(event.data);};
    recorder.onstop = () => {stream.getTracks().forEach(track => track.stop()); setUrl(URL.createObjectURL(new Blob(chunks, {type}))); setFileName('浏览器生成的无版权合成片段'); setSynthetic(true); setMessage('合成片段仅用于功能和帧时测试，不能证明实际动画画质改善');};
    recorder.start();
    const start = performance.now();
    function draw(now: number) {
      if (!context) return;
      context.fillStyle = '#111e2b'; context.fillRect(0, 0, 320, 180);
      for (let y = 0; y < 180; y += 20) for (let x = 0; x < 320; x += 20) {context.fillStyle = (x + y) % 40 ? '#31536a' : '#446f84'; context.fillRect(x, y, 20, 20);}
      const left = Math.round((now - start) / 12) % 260;
      context.fillStyle = '#e7b469'; context.fillRect(left, 46, 48, 48);
      context.fillStyle = '#f5f8fc'; context.font = '18px sans-serif'; context.fillText('LOCAL TEST', 80, 140);
      if (now - start < 8000) requestAnimationFrame(draw); else recorder.stop();
    }
    requestAnimationFrame(draw);
    setMessage('正在本机生成八秒测试片段…');
  }
  return <main className="ai-lab">
    <h1>大彪TV · 本地 AI 画质实验</h1>
    <p>选择本机已获授权的视频。文件通过浏览器 object URL 播放，不上传服务器。默认原画；可手动选择动画模型，由本机 GPU 处理。按住 A/B 按钮比较同一观看尺寸的原画。</p>
    <label className="ai-lab-file">选择本地视频<input type="file" accept="video/*" onChange={event => choose(event.target.files?.[0])}/></label>
    <button className="ai-lab-generate" type="button" onClick={makeSyntheticClip}>生成无版权测试片段</button>
    {message && <p role="status">{message}</p>}
    {fileName && <p>当前文件：{fileName}</p>}
    {url && synthetic && <p><a href={url} download="dbtv-local-test.webm">保存本机测试片段</a></p>}
    <div className="video-shell ai-lab-stage">
      <video key={`video-${url}`} ref={videoRef} src={url || undefined} controls controlsList="nofullscreen" playsInline loop preload="metadata"/>
      {url && <AIEnhancer key={`ai-${url}`} videoRef={videoRef}/>}
    </div>
    <p className="ai-lab-note">测试时记录浏览器、设备、视频尺寸、原画与增强同尺寸观感，以及平均帧耗时和掉帧数。帧耗时包含 CPU 与 GPU 完成等待，不是画质评分。原生全屏、画中画和投屏会回到原画。</p>
  </main>;
}

const mount = document.getElementById('root')! as HTMLElement & {aiLabRoot?: Root};
const root = mount.aiLabRoot ??= createRoot(mount);
root.render(<Lab/>);
