# 浏览器本地 RealESRGAN_x4plus 单帧实验

旧 WebSR / Anime4K 动画及真人 S/M/L 模型已从此本地测试分支的播放器入口、静态权重和 npm 依赖中移除。Git 历史仍可回退。点播、直播、后台和原画播放仍在完整网站中。

新入口在播放器和 `/ai-lab.html`：默认关闭，只在手动点击「x4plus 单帧预览」后加载约 64 MiB 的 ONNX 模型，在观看设备的浏览器内处理**已暂停视频中央最多 128×128 原生像素**。它将该区域输出为 512×512，并在相同显示尺寸下呈现原画 A / 模型 B。视频始终按原画播放；这不是整段视频增强，也不把 128×128 结果冒充为整幅高清视频。没有服务器推理、影片上传、跨域或 DRM 绕过。若安全上下文、WebGPU、CORS、模型校验或 GPU 出错，就显示原因并保持原画。播放、定位、换源、关闭、画中画、投屏、原生全屏都会隐藏过期预览。已开始的 ONNX 推理不能在中途强制中断；关闭会立即隐藏结果、阻止新任务，等待当前单帧调用返回后释放会话。

## 来源与本机模型

使用 [Real-ESRGAN 官方仓库](https://github.com/xinntao/Real-ESRGAN) 的 `RealESRGAN_x4plus`，不是 `realesr-general-x4v3` 或 GFPGAN。仓库代码是 BSD-3-Clause；[官方 v0.1.0 发布页](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0)提供原始权重，但未找到另列的权重许可。本实验权重和转换结果只保存在本机忽略目录，不随 Git 提交或公开分发。浏览器运行库为官方 npm `onnxruntime-web@1.22.0`，MIT。转换结构参照官方所用 [BasicSR RRDBNet](https://github.com/xinntao/BasicSR/blob/master/basicsr/archs/rrdbnet_arch.py)。

本机官方 `data/models/RealESRGAN_x4plus.pth`：67,040,989 字节，SHA-256 `4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1`。`scripts/export-realesrgan-x4plus.py` 先校验哈希，再用 PyTorch `weights_only=True` 受限加载，严格核对 RRDBNet 参数结构；没有执行上游脚本中不受限的 checkpoint 加载。ONNX opset 17、动态高宽，经 ONNX checker 和 PyTorch / ONNX Runtime CPU 在 8×8、16×20 输入上比对，最大绝对误差分别为 `1.2516975e-05` 和 `3.5762787e-06`。导出 `data/models/RealESRGAN_x4plus.onnx`：67,051,647 字节，SHA-256 `5e5264c2a9343f4c87f3824a14a1b27c3762f8a5060fd44a3f31f33724694637`。客户端在使用前再次验证完整文件的大小和 SHA-256。

若需在**另一份本地隔离测试副本**重建模型，先从上述官方发布页下载 PTH 到 `data/models/RealESRGAN_x4plus.pth`，确认 SHA-256，然后使用 Python 3.9+ 的项目专用虚拟环境安装 PyPI wheel：`numpy==1.26.4 torch==2.2.2 onnx==1.16.2 onnxruntime==1.19.2`。在仓库根目录运行：

```sh
data/x4plus-venv/bin/python scripts/export-realesrgan-x4plus.py \
  data/models/RealESRGAN_x4plus.pth data/models/RealESRGAN_x4plus.onnx
mkdir -p client/public/models/realesrgan
cp data/models/RealESRGAN_x4plus.onnx client/public/models/realesrgan/RealESRGAN_x4plus.onnx
```

`data/` 和 `client/public/models/realesrgan/*.onnx` 不进入 Git。没有本机 ONNX 文件时按钮报错并继续原画。完整站点本地测试地址 `http://127.0.0.1:5173/`，独立授权视频/合成片段入口 `http://127.0.0.1:5173/ai-lab.html`，均只绑定 `127.0.0.1`。

## 当前证据和边界

2026-10-23 在本机 Chrome 的无版权合成 320×180 WebM 上，暂停帧原生裁切 128×128，经浏览器 ONNX Runtime WebGPU 返回 512×512 模型输出并显示同尺寸 A/B；首帧推理 **1,522 ms**，一次重复预览 **958 ms**，仅对应这两次局部单帧和此设备。关闭、再开启及开始播放后隐藏预览也通过了浏览器交互测试。未测长时间连续帧、720p/1080p 全帧、手机/电视、真实真人素材的画质、掉帧或热负荷。因此不能承诺视频实时增强、比原画更清晰，或所有设备可用。合成棋盘图只能证明管线工作，不能证明真人细节恢复。模型的原始发布也提示人脸和文字可能效果欠佳。见 [ONNX Runtime WebGPU 文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)。
