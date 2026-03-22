# SeedVR2 for After Effects

**Run SeedVR2 AI upscaling directly inside After Effects — no switching apps, no manual exporting.**

This script connects After Effects to SeedVR2 (ByteDance), using the same pipeline as the [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) node by numz & AInVFX. Select a layer, click a button, get a high-quality upscaled result back in your timeline — GPU accelerated.

Works on single images and PNG sequences.

![demo1](01.png)
![demo2](02.png)

---

## Features

- ✅ One-click AI upscaling from inside AE
- ✅ GPU accelerated with BlockSwap — runs on 12-16GB VRAM
- ✅ Supports single images and PNG sequences
- ✅ Same pipeline as the ComfyUI node (4 phases: encode → DiT → decode → post-process)
- ✅ Color correction (LAB, Wavelet, HSV, AdaIN)
- ✅ Configurable BlockSwap, tiling, and resolution
- ✅ Output saved next to your AE project, auto-imported into the timeline

---

## Requirements

| Requirement | Notes |
|---|---|
| After Effects | CC 2019 or later |
| ComfyUI | Already installed and working |
| ComfyUI-SeedVR2_VideoUpscaler | Node installed |
| SeedVR2 models | Downloaded in `models/SEEDVR2/` |
| Python | The one bundled with ComfyUI |
| GPU (NVIDIA CUDA) | Required — 12GB+ VRAM recommended |
| OS | Windows ✅ tested / macOS ⚠ not tested |

### Required models (auto-downloaded by ComfyUI on first use)

| Model | Size | Notes |
|---|---|---|
| `seedvr2_ema_7b_fp16.safetensors` | ~14GB | DiT — best quality |
| `ema_vae_fp16.safetensors` | ~800MB | VAE — required |

FP8 and GGUF variants also supported — place them in `models/SEEDVR2/`.

---

## Installation

### Step 1 — Install the ComfyUI node

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git
```

Run ComfyUI once and use the node to download the models automatically.

### Step 2 — Copy the script files

Copy the **`server/` folder** and **`jsx/` folder** to your After Effects Scripts directory:

**Windows:**
```
C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\
```

The JSX panel must go in the **ScriptUI Panels** subfolder so it appears under **Window** in AE:

```
Scripts/
├── ScriptUI Panels/
│   └── SeedVR2_AE.jsx        ← goes here
└── server/
    └── seedvr2_process.py
```

### Step 3 — Allow scripts to write files

In After Effects:  
**Edit → Preferences → Scripting & Expressions**  
→ Enable **"Allow Scripts to Write Files and Access Network"**

### Step 4 — Open the panel

**Window → SeedVR2_AE.jsx**

---

## Usage

### Single image

1. Select an image layer in your composition
2. Set ComfyUI path, DiT model, VAE model
3. Set max resolution (e.g. 2000)
4. Click **▶ Upscale**
5. The upscaled result appears as a new layer

Output is saved in a `SeedVR2/` subfolder next to your `.aep` project file.

### PNG sequence

1. Import your PNG sequence into AE (`File → Import`, PNG Sequence)
2. Add it to a comp and select the layer
3. Click **▶ Upscale**
4. All frames are processed — model loads once, processes all frames
5. The resulting sequence is automatically imported back

---

## Parameters

| Parameter | Description |
|---|---|
| **ComfyUI root** | Path to your ComfyUI installation folder |
| **DiT model** | The diffusion transformer model (auto-detected from `models/SEEDVR2/`) |
| **VAE model** | The encoder/decoder model (auto-detected) |
| **Max resolution** | Maximum output resolution for any edge (default: 2000) |
| **Color correction** | LAB (recommended), Wavelet, HSV, AdaIN, or None |
| **Seed** | Random seed for reproducible results |
| **Tile size** | VAE tile size — lower = less VRAM |
| **Tiling** | Enable tiled encode/decode for high-res images |
| **Block swap** | Transformer blocks offloaded to CPU (default: 35) |
| **Offload device** | `none` = fastest, `cpu` = safer on low VRAM |

### BlockSwap guide

| VRAM | Block swap | Offload device |
|---|---|---|
| 8GB | 35-36 | cpu |
| 12-16GB | 30-35 | cpu |
| 24GB+ | 0 | none |

---

## How it works

The script imports the SeedVR2 pipeline directly from your ComfyUI custom node installation — no code duplication, no separate model files. It runs the same 4-phase pipeline:

1. **VAE Encode** — compress input frames to latent space
2. **DiT Upscale** — one-step diffusion upscaling
3. **VAE Decode** — reconstruct high-resolution frames
4. **Post-process** — color correction and assembly

After Effects ExtendScript launches Python invisibly via a `.bat` + `.vbs` launcher, polls a `status.json` file for progress, and imports the result when done.

---

## Video not supported directly

Video layers (`.mp4`, `.mov`) are not supported. Export as PNG sequence first:

1. Select video layer → **File → Export → Add to Render Queue**
2. Output Module → **Format: PNG Sequence**
3. Render → import the sequence → run this script

---

## License

This script (JSX + Python) is released under **MIT License**.

The underlying models and node have their own licenses:
- **SeedVR2 models** (ByteDance): [Apache 2.0](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler/blob/main/LICENSE) ✓ commercial use allowed
- **ComfyUI-SeedVR2_VideoUpscaler** (numz/AInVFX): [Apache 2.0](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler/blob/main/LICENSE) ✓

---

## Credits

- [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) by **numz** & **AInVFX** — the ComfyUI node this script is built on
- [SeedVR2](https://github.com/ByteDance-Seed/SeedVR) by **ByteDance Seed** — the original model
- AE script by **@digigabbo**

---

## Support

If you find this useful and want to support the work — thank you! ☕

**[![Support](https://img.shields.io/badge/Support-PayPal-blue)](https://paypal.me/digigabbo)**

Any amount is appreciated and helps keep these tools coming.
