# 本地动画画质增强实验

播放器默认显示原画。用户手动选择「动画 · Anime4K CNN」时，浏览器才加载 WebSR 和对应模型，并在观看设备 WebGPU 上逐帧处理。轻量 S、标准 M、高负载 L 分别加载[官方 Anime4K](https://github.com/bloc97/Anime4K) 的 `cnn-2x-s-an.json`、`cnn-2x-m-an.json`、`cnn-2x-l-an.json`。动画权重文件的 SHA-256 依次为 `aecd5bf215a8962a13e38a8623433a7477f853ccdaefe8b6274f9aa6828368e0`、`f5833e47a3838c9f14558e413074219898deba8e73b661dcb54f38dca5eadcf7`、`24b8ed0a4da6a4290ad772af2b993d15df917d15ad69739a046043492ee6ed4e`。这些是权重文件大小约 13/34/114 KB，不是显存占用。固定 [WebSR 官方 npm 对应源码](https://github.com/sb2702/websr) `@websr/websr@0.0.16`，MIT；权重和许可证见 `client/public/models/websr`。没有加载真人权重或 x4plus/ONNX Runtime。x4plus 只留在 Git 历史及非公开 `data/models` 本机归档，不再由网站提供。

S 网络预测统一明暗残差，M/L 预测 RGB 残差；WebSR 将模型结果经 pixel shuffle 与线性插值底图组合为 2 倍输出。这是单帧 CNN，不是时序恢复或找回原影片丢失细节。原始 Anime4K 主要面向动画，不能保证每个低清或压缩片源改善。按住 A/B 看原画，状态显示原生输入、模型输出、实际播放窗口、平均帧耗时和浏览器报告的掉帧。若窗口比输出大，会明示仍被浏览器放大。可在本机 `/ai-lab.html` 选已授权文件（object URL，不上传），或生成无版权合成片段用于功能和帧时测试；合成片段不能证明实际动画观感。

需安全上下文、WebGPU、视频帧回调、可读取的视频画面。跨域或 DRM 限制不绕过。模型/GPU/帧处理出错则回原画；暂停、隐藏标签会停止安排新帧，关闭模式会立即隐藏画布并取消后续帧，已提交 GPU 的工作可能短暂完成后释放。切集会卸载组件并清理。原生全屏、画中画和投屏返回原画；播放器容器全屏包含增强画布与控件。原生字幕轨启用时返回原画以保留字幕。若发热或卡顿，改轻量档或关闭。

本轮验证和未覆盖设备、片源详见 [全站回归记录](FULL-SITE-REGRESSION-2026-10-27.md)。不要把功能可运行等同于画质一定提升或全分辨率实时达标。
