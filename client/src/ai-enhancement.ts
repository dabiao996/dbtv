import type WebSR from 'websr-audited-source';

export type EnhancementMode = 'light' | 'standard';
export type EnhancementStatus = {
  active: boolean;
  message: string;
  frameMs?: number;
  droppedFrames?: number;
};

const MODELS: Record<EnhancementMode, {network: 'anime4k/cnn-2x-s' | 'anime4k/cnn-2x-m'; file: string}> = {
  light: {network: 'anime4k/cnn-2x-s', file: 'cnn-2x-s-rl.json'},
  standard: {network: 'anime4k/cnn-2x-m', file: 'cnn-2x-m-rl.json'},
};

// The 2D read is deliberately local: it catches tainted and protected video before WebGPU import.
export function checkReadableFrame(video: HTMLVideoElement): void {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const context = probe.getContext('2d', {willReadFrequently: true});
  if (!context) throw new Error('无法检测视频画面是否可读取');
  try {
    context.drawImage(video, 0, 0, 1, 1);
    context.getImageData(0, 0, 1, 1);
  } catch {
    throw new Error('当前视频禁止浏览器读取画面（可能是跨域或受保护内容），已恢复原画');
  }
}

export class AIEnhancementSession {
  private websr?: WebSR;
  private device?: {lost: Promise<unknown>; queue: {onSubmittedWorkDone(): Promise<void>}; destroy(): void};
  private callbackId?: number;
  private active = false;
  private rendering = false;
  private pendingRender = false;
  private frameTimes: number[] = [];
  private completedFrames = 0;
  private needsVisibleUpdate = false;
  private originalWidth = 0;
  private originalHeight = 0;
  private onStatus: (status: EnhancementStatus) => void;

  constructor(private video: HTMLVideoElement, private canvas: HTMLCanvasElement, onStatus: (status: EnhancementStatus) => void) {
    this.onStatus = onStatus;
  }

  async start(mode: EnhancementMode, signal: AbortSignal): Promise<void> {
    if (!window.isSecureContext) throw new Error('AI 增强需要 HTTPS 或本机 localhost 安全上下文');
    if (!('gpu' in navigator)) throw new Error('此浏览器或设备未提供 WebGPU，继续播放原画');
    if (!this.video.requestVideoFrameCallback || !this.video.cancelVideoFrameCallback) throw new Error('此浏览器没有视频帧回调，继续播放原画');
    if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('视频画面尚未准备好');
    checkReadableFrame(this.video);
    const model = MODELS[mode];
    const response = await fetch(`${import.meta.env.BASE_URL}models/websr/${model.file}`, {signal, cache: 'force-cache'});
    if (!response.ok) throw new Error(`真人模型加载失败（HTTP ${response.status}），继续播放原画`);
    const weights = await response.json();
    if (signal.aborted) return;
    // Import only after the user explicitly enables enhancement.
    const {default: WebSRClass} = await import('websr-audited-source');
    const gpu = await WebSRClass.initWebGPU();
    if (!gpu) throw new Error('WebGPU 适配器不可用，继续播放原画');
    this.device = gpu;
    if (signal.aborted) {gpu.destroy(); this.device = undefined; return;}
    this.originalWidth = this.video.videoWidth;
    this.originalHeight = this.video.videoHeight;
    this.websr = new WebSRClass({canvas: this.canvas, weights, network_name: model.network, gpu});
    this.active = true;
    void gpu.lost.then(() => this.fail('GPU 设备已断开，已恢复原画'));
    this.video.addEventListener('play', this.onPlay);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('seeking', this.onSeeking);
    this.video.addEventListener('seeked', this.onSeeked);
    this.video.addEventListener('canplay', this.onCanPlay);
    this.video.addEventListener('resize', this.onResize);
    this.video.addEventListener('ended', this.onEnded);
    this.video.addEventListener('enterpictureinpicture', this.onPiP);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.video.addEventListener('webkitbeginfullscreen', this.onNativeFullscreen);
    this.video.addEventListener('webkitendfullscreen', this.onNativeFullscreen);
    this.video.remote?.addEventListener('connect', this.onCast);
    this.video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', this.onWirelessTarget);
    await this.renderFrame();
    if (this.active && !this.video.paused) this.schedule();
  }

  private schedule() {
    if (this.active && !this.video.paused && this.callbackId === undefined) {
      this.callbackId = this.video.requestVideoFrameCallback(() => {
        this.callbackId = undefined;
        void this.renderFrame().then(() => this.schedule());
      });
    }
  }

  private async renderFrame() {
    if (!this.active || this.rendering || !this.websr || !this.device || this.video.readyState < 2) return;
    if (this.video.videoWidth !== this.originalWidth || this.video.videoHeight !== this.originalHeight) {
      this.fail('视频分辨率发生变化，请重新打开 AI 增强');
      return;
    }
    if ([...this.video.textTracks].some(track => track.mode === 'showing')) {
      this.fail('当前字幕由原生播放器显示，已恢复原画以保留字幕');
      return;
    }
    this.rendering = true;
    const start = performance.now();
    try {
      await this.websr.render(this.video);
      await this.device.queue.onSubmittedWorkDone();
      if (!this.active) return;
      const ms = performance.now() - start;
      // The first render includes shader compilation, so report steady-frame cost separately.
      if (this.completedFrames > 0) {
        this.frameTimes.push(ms);
        if (this.frameTimes.length > 30) this.frameTimes.shift();
      }
      const average = this.frameTimes.length ? this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length : undefined;
      const dropped = this.video.getVideoPlaybackQuality?.().droppedVideoFrames;
      this.completedFrames++;
      if (this.completedFrames === 1 || this.completedFrames % 15 === 0 || this.needsVisibleUpdate) {
        this.needsVisibleUpdate = false;
        this.onStatus({active: true, message: average === undefined ? '模型已加载；首帧正在预热' : average > 50 ? '设备处理较慢；可切换轻量档或关闭增强' : 'AI 增强运行中', frameMs: average === undefined ? undefined : Math.round(average), droppedFrames: dropped});
      }
    } catch (error) {
      this.fail(error instanceof Error ? `GPU 处理失败：${error.message}` : 'GPU 处理失败，已恢复原画');
    } finally {
      this.rendering = false;
      if (this.pendingRender && this.active) {
        this.pendingRender = false;
        void this.renderFrame().then(() => this.schedule());
      }
    }
  }

  private onPlay = () => this.schedule();
  private onPause = () => this.cancelFrame();
  private onSeeking = () => {this.cancelFrame(); this.needsVisibleUpdate = true; this.onStatus({active: false, message: '定位中，暂时显示原画'});};
  private onSeeked = () => {if (this.active) {this.pendingRender = true; if (!this.rendering) {this.pendingRender = false; void this.renderFrame().then(() => this.schedule());}}};
  private onCanPlay = () => {if (this.active && this.video.paused) void this.renderFrame();};
  private onResize = () => this.fail('视频分辨率变化，已恢复原画；可以重新打开增强');
  private onEnded = () => this.fail('播放结束，已恢复原画');
  private onPiP = () => this.fail('画中画不支持 AI 增强，已恢复原画');
  private onCast = () => this.fail('投屏不支持本机 AI 增强，已恢复原画');
  private onWirelessTarget = () => {if ((this.video as HTMLVideoElement & {webkitCurrentPlaybackTargetIsWireless?: boolean}).webkitCurrentPlaybackTargetIsWireless) this.onCast();};
  private onNativeFullscreen = () => this.fail('原生全屏不支持增强，已恢复原画');
  private onFullscreen = () => {if (document.fullscreenElement === this.video) this.onNativeFullscreen();};

  private fail(message: string) {
    if (!this.active) return;
    this.onStatus({active: false, message});
    this.stop();
  }

  private cancelFrame() {
    if (this.callbackId !== undefined) this.video.cancelVideoFrameCallback(this.callbackId);
    this.callbackId = undefined;
  }

  stop() {
    this.active = false;
    this.cancelFrame();
    this.video.removeEventListener('play', this.onPlay);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('canplay', this.onCanPlay);
    this.video.removeEventListener('resize', this.onResize);
    this.video.removeEventListener('ended', this.onEnded);
    this.video.removeEventListener('enterpictureinpicture', this.onPiP);
    this.video.removeEventListener('webkitbeginfullscreen', this.onNativeFullscreen);
    this.video.removeEventListener('webkitendfullscreen', this.onNativeFullscreen);
    this.video.remote?.removeEventListener('connect', this.onCast);
    this.video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', this.onWirelessTarget);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    if (this.websr?.context) void this.websr.destroy();
    else this.device?.destroy();
    this.websr = undefined;
    this.device = undefined;
  }
}
