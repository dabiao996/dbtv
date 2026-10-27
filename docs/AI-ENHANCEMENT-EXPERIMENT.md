# 浏览器本地 RealESRGAN_x4plus 实验

旧 WebSR 与 Anime4K 动画、真人 S/M/L 模型已从本地测试分支移除，包括播放器入口、静态权重、源码别名和 npm 依赖。Git 历史保留可回退。完整网站的点播、直播、后台及原画播放保持原状；目前画质增强入口仅显示原画状态。

目标模型是 Real-ESRGAN 官方的 `RealESRGAN_x4plus.pth`，不是轻量版 `realesr-general-x4v3`，也不包含 GFPGAN。官方仓库使用 BSD-3-Clause；官方发布页提供 PyTorch 权重，官方转换脚本提供 ONNX 导出思路，但该脚本使用不受限的 `torch.load`，不能直接执行。浏览器需使用可信来源转换后的模型并验证结构与数值，再尝试 ONNX Runtime Web WebGPU。本实验不上传影片帧或使用服务器推理。

模型可否在此 iMac 的浏览器中加载、单帧推理、达到视频实时速度、改善真人观感均尚未证实。验证失败时保留原画；不能把普通放大或滤镜称作该模型的输出。

来源：[Real-ESRGAN 官方仓库](https://github.com/xinntao/Real-ESRGAN)、[v0.1.0 官方发布](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0)、[官方 ONNX 转换脚本](https://github.com/xinntao/Real-ESRGAN/blob/master/scripts/pytorch2onnx.py)、[ONNX Runtime WebGPU 文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)。
