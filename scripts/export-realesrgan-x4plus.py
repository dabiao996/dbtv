"""Convert the pinned official RealESRGAN_x4plus checkpoint to ONNX locally.

Architecture follows BasicSR's RRDBNet (scale=4, 64 features, 23 RRDB blocks).
The checkpoint is loaded with PyTorch's restricted weights-only unpickler.
No user image or video is read by this script.
"""

import argparse
import hashlib
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn
from torch.nn import functional as F

OFFICIAL_SHA256 = "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1"


class ResidualDenseBlock(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(64, 32, 3, 1, 1)
        self.conv2 = nn.Conv2d(96, 32, 3, 1, 1)
        self.conv3 = nn.Conv2d(128, 32, 3, 1, 1)
        self.conv4 = nn.Conv2d(160, 32, 3, 1, 1)
        self.conv5 = nn.Conv2d(192, 64, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self):
        super().__init__()
        self.rdb1 = ResidualDenseBlock()
        self.rdb2 = ResidualDenseBlock()
        self.rdb3 = ResidualDenseBlock()

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_first = nn.Conv2d(3, 64, 3, 1, 1)
        self.body = nn.Sequential(*(RRDB() for _ in range(23)))
        self.conv_body = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2)

    def forward(self, x):
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if sha256(args.checkpoint) != OFFICIAL_SHA256:
        raise SystemExit("Official checkpoint SHA-256 mismatch; conversion refused")
    torch.set_num_threads(4)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    if set(checkpoint) != {"params_ema"} or not isinstance(checkpoint["params_ema"], dict):
        raise SystemExit("Unexpected checkpoint structure; conversion refused")
    model = RRDBNet().eval()
    model.load_state_dict(checkpoint["params_ema"], strict=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sample = torch.zeros(1, 3, 16, 16)
    with torch.no_grad():
        torch.onnx.export(model, sample, args.output, export_params=True, opset_version=17,
                          input_names=["input"], output_names=["output"],
                          dynamic_axes={"input": {2: "height", 3: "width"},
                                        "output": {2: "output_height", 3: "output_width"}})
    graph = onnx.load(str(args.output))
    onnx.checker.check_model(graph)
    session = ort.InferenceSession(str(args.output), providers=["CPUExecutionProvider"])
    generator = np.random.default_rng(17)
    for height, width in ((8, 8), (16, 20)):
        frame = generator.random((1, 3, height, width), dtype=np.float32)
        with torch.no_grad():
            reference = model(torch.from_numpy(frame)).numpy()
        converted = session.run(["output"], {"input": frame})[0]
        error = float(np.max(np.abs(reference - converted)))
        print(f"{width}x{height} -> {converted.shape[-1]}x{converted.shape[-2]} max_abs_error={error:.8g}")
        if converted.shape != reference.shape or not np.isfinite(converted).all() or error > 1e-4:
            raise SystemExit("ONNX numerical comparison failed")
    print(f"official_checkpoint_sha256={OFFICIAL_SHA256}")
    print(f"onnx_sha256={sha256(args.output)} size={args.output.stat().st_size}")


if __name__ == "__main__":
    main()
