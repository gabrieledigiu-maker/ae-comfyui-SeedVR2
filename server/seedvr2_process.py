#!/usr/bin/env python3
"""
seedvr2_process.py — SeedVR2 upscaler for After Effects.
Imports directly from the ComfyUI custom node — same pipeline, no duplication.

Supports single images and PNG sequences (all frames processed as one batch
for temporal consistency — same as the ComfyUI node).
"""

import os, sys, json, argparse, traceback, glob

# Force UTF-8 output — SeedVR2 uses emojis in print statements
os.environ["PYTHONIOENCODING"] = "utf-8"
os.environ["PYTHONUTF8"] = "1"
if sys.stdout.encoding != "utf-8":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# ── Import comfy BEFORE torch ─────────────────────────────────────────────────
# ComfyUI's aimdo driver hook (async weight offloading, pinned memory,
# DynamicVRAM) must be initialized before PyTorch allocates CUDA memory.
# This mirrors the ComfyUI startup sequence and enables the same optimizations
# that make BlockSwap fast (22s/batch vs 300s/batch without).
def _bootstrap_comfy():
    # Find ComfyUI path from sys.argv so we can add it before torch loads
    comfyui_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--comfyui" and i + 1 < len(sys.argv):
            comfyui_path = sys.argv[i + 1]
            break
    if not comfyui_path:
        return
    if comfyui_path not in sys.path:
        sys.path.insert(0, comfyui_path)
    try:
        import comfy.model_management
        print("[SeedVR2] comfy.model_management bootstrapped (aimdo/pinned memory enabled)", flush=True)
    except Exception as e:
        print(f"[SeedVR2] comfy bootstrap skipped: {e}", flush=True)

_bootstrap_comfy()

import torch

# ── Apply global SageAttention patch (mirrors [comfy-env] Auto-enabled sage attention) ──
# ComfyUI patches torch.nn.functional.scaled_dot_product_attention globally at startup.
# This makes ALL attention ops use SageAttention regardless of the node's attention_mode.
# Without this, sdpa falls back to Triton on first call → 300s compilation overhead.
def _patch_sage_attention():
    try:
        import sageattention
        import torch.nn.functional as F
        # Check if sageattention has the right API
        if hasattr(sageattention, 'sageattn'):
            _orig_sdpa = F.scaled_dot_product_attention
            def _sage_sdpa(query, key, value, attn_mask=None, dropout_p=0.0,
                           is_causal=False, scale=None, **kwargs):
                # SageAttention doesn't support all sdpa args — fallback gracefully
                try:
                    return sageattention.sageattn(query, key, value,
                                                  attn_mask=attn_mask,
                                                  is_causal=is_causal,
                                                  scale=scale)
                except Exception:
                    return _orig_sdpa(query, key, value, attn_mask=attn_mask,
                                     dropout_p=dropout_p, is_causal=is_causal,
                                     scale=scale)
            F.scaled_dot_product_attention = _sage_sdpa
            print("[SeedVR2] Global SageAttention patch applied (matches ComfyUI behavior)", flush=True)
        else:
            print("[SeedVR2] SageAttention found but sageattn API not available", flush=True)
    except ImportError:
        pass  # SageAttention not installed — no patch needed
    except Exception as e:
        print(f"[SeedVR2] SageAttention patch skipped: {e}", flush=True)

_patch_sage_attention()
import numpy as np
from PIL import Image



def write_status(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)

def find_node_dir(comfyui_root):
    custom_nodes = os.path.join(comfyui_root, "custom_nodes")
    candidates = [
        "ComfyUI-SeedVR2_VideoUpscaler",
        "comfyui-seedvr2_videoupscaler",
        "ComfyUI_SeedVR2_VideoUpscaler",
    ]
    for name in candidates:
        p = os.path.join(custom_nodes, name)
        if os.path.isdir(p): return p
    if os.path.isdir(custom_nodes):
        for d in os.listdir(custom_nodes):
            if "seedvr2" in d.lower() or ("seed" in d.lower() and "vr" in d.lower()):
                return os.path.join(custom_nodes, d)
    return None

def setup_paths(comfyui_root, node_dir):
    """Add ComfyUI and node to sys.path so imports work."""
    for p in [comfyui_root, os.path.dirname(comfyui_root), node_dir]:
        if p and p not in sys.path:
            sys.path.insert(0, p)

def images_to_tensor(image_paths):
    """Load PNG images → [N, H, W, C] float32 tensor in [0,1] range."""
    frames = []
    for p in image_paths:
        img = Image.open(p).convert("RGB")
        arr = np.array(img).astype(np.float32) / 255.0
        frames.append(arr)
    return torch.from_numpy(np.stack(frames, axis=0))  # [N, H, W, 3]

def tensor_to_images(tensor, output_paths):
    """Save [N, H, W, C] float32 tensor → PNG files."""
    arr = tensor.cpu().float().numpy()
    arr = (arr * 255).clip(0, 255).astype(np.uint8)
    for i, p in enumerate(output_paths):
        Image.fromarray(arr[i]).save(p, optimize=False)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",          required=True,  help="Single image OR input_dir for sequence mode")
    ap.add_argument("--output",         required=True,  help="Output path OR output_dir for sequence mode")
    ap.add_argument("--mode",           default="single", choices=["single", "sequence"])
    ap.add_argument("--pattern",        default="*.png", help="Glob pattern for sequence mode")
    ap.add_argument("--comfyui",        required=True)
    ap.add_argument("--dit_model",      required=True,  help="DiT model filename (e.g. seedvr2_ema_7b_fp16.safetensors)")
    ap.add_argument("--vae_model",      required=True,  help="VAE model filename (e.g. ema_vae_fp16.safetensors)")
    ap.add_argument("--device",         default="cuda")
    ap.add_argument("--seed",           type=int, default=42)
    ap.add_argument("--resolution",     type=int, default=1080)
    ap.add_argument("--max_resolution", type=int, default=0)
    ap.add_argument("--batch_size",          type=int, default=1)
    ap.add_argument("--uniform_batch_size",  action="store_true")
    ap.add_argument("--color_correction", default="lab",
                    choices=["lab","wavelet","wavelet_adaptive","hsv","adain","none"])
    ap.add_argument("--temporal_overlap",   type=int, default=0)
    ap.add_argument("--blocks_to_swap",     type=int, default=35)
    ap.add_argument("--attention_mode",       default="auto",
                    choices=["auto","sageattn_2","sdpa","flash_attn","flash_attn_2","flash_attn_3","sageattn_3"])
    ap.add_argument("--prepend_frames",   type=int, default=0)
    ap.add_argument("--input_noise_scale",  type=float, default=0.0)
    ap.add_argument("--latent_noise_scale", type=float, default=0.0)
    ap.add_argument("--encode_tiled",   action="store_true")
    ap.add_argument("--decode_tiled",   action="store_true")
    ap.add_argument("--encode_tile_size",   type=int, default=1024)
    ap.add_argument("--encode_tile_overlap", type=int, default=128)
    ap.add_argument("--decode_tile_size",   type=int, default=768)
    ap.add_argument("--decode_tile_overlap", type=int, default=128)
    ap.add_argument("--offload_device", default="cpu", choices=["none", "cpu"])
    ap.add_argument("--status",         required=True)
    ap.add_argument("--pid_file",       default=None)
    ap.add_argument("--keep_input",     action="store_true")
    args = ap.parse_args()

    # Write PID immediately so JSX can kill us if needed
    if args.pid_file:
        try:
            with open(args.pid_file, "w") as _pf:
                _pf.write(str(os.getpid()))
        except Exception:
            pass

    write_status(args.status, {"status": "starting", "progress": "Initializing…"})

    try:
        # ── Setup paths ─────────────────────────────────────────
        node_dir = find_node_dir(args.comfyui)
        if not node_dir:
            raise FileNotFoundError(
                f"ComfyUI-SeedVR2_VideoUpscaler not found in {args.comfyui}/custom_nodes/\n"
                "Make sure the node is installed."
            )
        setup_paths(args.comfyui, node_dir)
        print(f"[SeedVR2] Node: {node_dir}", flush=True)

        # ── Stub tutti i moduli ComfyUI-only prima di importare il nodo ──
        write_status(args.status, {"status": "starting", "progress": "Setting up environment…"})

        import types

        def _make_stub(name):
            m = types.ModuleType(name)
            # Rende qualsiasi attributo un altro stub (lazy)
            class _Stub:
                def __init__(self, *a, **kw): pass
                def __call__(self, *a, **kw): return _Stub()
                def __getattr__(self, k): return _Stub()
                def __iter__(self): return iter([])
                def __class_getitem__(cls, k): return cls
            m.__stub__ = _Stub
            for attr in ["io","ComfyExtension","ComfyNode","Schema","NodeOutput",
                         "Image","Int","Float","Boolean","Combo","String","Custom",
                         "Input","Output","TORCH_COMPILE_ARGS","ProgressBar"]:
                setattr(m, attr, _Stub)
            return m

        # Stub comfy_api e relativi
        for mod in ["comfy_api", "comfy_api.latest", "comfy_api.latest.io"]:
            if mod not in sys.modules:
                sys.modules[mod] = _make_stub(mod)

        # Stub comfy_execution
        if "comfy_execution" not in sys.modules:
            ce = types.ModuleType("comfy_execution")
            ce_utils = types.ModuleType("comfy_execution.utils")
            class _FakeCtx: node_id = "ae_node"
            ce_utils.get_executing_context = lambda: _FakeCtx()
            sys.modules["comfy_execution"] = ce
            sys.modules["comfy_execution.utils"] = ce_utils

        # Try to import real comfy — it initializes CUDA optimizations (DynamicVRAM, pinned memory etc)
        if "comfy" not in sys.modules:
            try:
                import comfy.model_management
                import comfy.utils
            except Exception:
                pass

        # Stub folder_paths
        if "folder_paths" not in sys.modules:
            fp = types.ModuleType("folder_paths")
            fp.models_dir = os.path.join(args.comfyui, "models")
            fp.get_filename_list = lambda *a, **kw: []
            fp.get_full_path = lambda *a, **kw: None
            sys.modules["folder_paths"] = fp

        # ── Import from custom node ──────────────────────────────
        write_status(args.status, {"status": "starting", "progress": "Importing SeedVR2…"})

        src_dir = os.path.join(node_dir, "src")
        if src_dir not in sys.path:
            sys.path.insert(0, src_dir)
        if node_dir not in sys.path:
            sys.path.insert(0, node_dir)

        from src.core.generation_phases import (
            encode_all_batches,
            upscale_all_batches,
            decode_all_batches,
            postprocess_all_batches,
        )
        from src.core.generation_utils import (
            setup_generation_context,
            prepare_runner,
            compute_generation_info,
            load_text_embeddings,
            script_directory,
        )
        from src.utils.constants import get_base_cache_dir
        from src.utils.downloads import download_weight
        from src.utils.debug import Debug
        from src.optimization.memory_manager import complete_cleanup, cleanup_text_embeddings

        # Override cache dir — models are already in ComfyUI/models/SeedVR2
        # Try both casings — ComfyUI uses SEEDVR2 (uppercase)
        for _folder in ["SEEDVR2", "SeedVR2", "seedvr2"]:
            _candidate = os.path.join(args.comfyui, "models", _folder)
            if os.path.isdir(_candidate):
                _seedvr2_models_dir = _candidate
                break
        else:
            _seedvr2_models_dir = os.path.join(args.comfyui, "models", "SEEDVR2")
            os.makedirs(_seedvr2_models_dir, exist_ok=True)
        print(f"[SeedVR2] Models dir: {_seedvr2_models_dir}", flush=True)

        # Patch in every module that uses get_base_cache_dir
        import src.utils.constants as _constants
        import src.utils.downloads as _downloads
        import src.core.generation_utils as _gen_utils
        _constants.get_base_cache_dir  = lambda: _seedvr2_models_dir
        _downloads.get_base_cache_dir  = lambda: _seedvr2_models_dir
        try: _gen_utils.get_base_cache_dir = lambda: _seedvr2_models_dir
        except: pass

        print("[SeedVR2] Imports OK", flush=True)

        # ── Collect input frames ─────────────────────────────────
        write_status(args.status, {"status": "starting", "progress": "Loading images…"})

        if args.mode == "sequence":
            input_files = sorted(glob.glob(os.path.join(args.input, args.pattern)))
            if not input_files:
                raise FileNotFoundError(f"No files matching {args.pattern} in {args.input}")
            output_files = [os.path.join(args.output, os.path.basename(f)) for f in input_files]
            os.makedirs(args.output, exist_ok=True)
        else:
            input_files  = [args.input]
            output_files = [args.output]

        total_frames = len(input_files)
        print(f"[SeedVR2] Frames: {total_frames}", flush=True)

        # Load all frames as one tensor [N, H, W, C]
        images = images_to_tensor(input_files)
        orig_H, orig_W = images.shape[1], images.shape[2]
        print(f"[SeedVR2] Input resolution: {orig_W}x{orig_H}", flush=True)

        # ── Build config dicts (same structure as ComfyUI nodes) ─
        dit_device = args.device
        vae_device = args.device

        # Auto-detect best attention mode (mirrors ComfyUI global override)
        attention_mode = args.attention_mode
        if attention_mode == "auto":
            try:
                import sageattention
                attention_mode = "sageattn_2"
                print("[SeedVR2] SageAttention detected → using sageattn_2", flush=True)
            except ImportError:
                try:
                    import flash_attn
                    attention_mode = "flash_attn"
                    print("[SeedVR2] Flash Attention detected → using flash_attn", flush=True)
                except ImportError:
                    attention_mode = "sdpa"
                    print("[SeedVR2] Using sdpa (first batch may be slow due to Triton)", flush=True)
        print(f"[SeedVR2] Attention mode: {attention_mode}", flush=True)

        dit_config = {
            "model":            args.dit_model,
            "device":           dit_device,
            "offload_device":   args.offload_device,
            "cache_model":      False,
            "blocks_to_swap":   args.blocks_to_swap,
            "swap_io_components": False,
            "attention_mode":   attention_mode,
            "torch_compile_args": None,
            "node_id":          "ae_dit",
        }
        # VAE does not use attention — always sdpa
        vae_config = {
            "model":              args.vae_model,
            "device":             vae_device,
            "offload_device":     args.offload_device,
            "cache_model":        False,
            "encode_tiled":       args.encode_tiled,
            "encode_tile_size":   args.encode_tile_size,
            "encode_tile_overlap": args.encode_tile_overlap,
            "decode_tiled":       args.decode_tiled,
            "decode_tile_size":   args.decode_tile_size,
            "decode_tile_overlap": args.decode_tile_overlap,
            "tile_debug":         "false",
            "torch_compile_args": None,
            "node_id":            "ae_vae",
        }

        # ── Download models if needed ────────────────────────────
        write_status(args.status, {"status": "starting", "progress": "Checking models…"})
        debug = Debug(enabled=False)

        if not download_weight(dit_model=args.dit_model, vae_model=args.vae_model, debug=debug):
            raise RuntimeError(
                f"Failed to download models: DiT={args.dit_model}, VAE={args.vae_model}"
            )

        # ── Run pipeline ─────────────────────────────────────────
        write_status(args.status, {"status": "processing", "progress": "Setting up pipeline…"})

        dit_device_t = torch.device(dit_device)
        vae_device_t = torch.device(vae_device)

        offload = torch.device(args.offload_device) if args.offload_device != "none" else None

        ctx = setup_generation_context(
            dit_device=dit_device_t,
            vae_device=vae_device_t,
            dit_offload_device=offload,
            vae_offload_device=offload,
            tensor_offload_device=offload,
            debug=debug,
        )

        # BlockSwap — same as ComfyUI workflow (35 blocks offloaded to CPU)
        block_swap_config = None
        if args.blocks_to_swap > 0 and offload is not None:
            block_swap_config = {
                "blocks_to_swap":     args.blocks_to_swap,
                "swap_io_components": False,
                "offload_device":     offload,
            }
        print(f"[SeedVR2] BlockSwap: {args.blocks_to_swap} blocks → {args.offload_device}", flush=True)

        runner, cache_context = prepare_runner(
            dit_model=args.dit_model,
            vae_model=args.vae_model,
            model_dir=_seedvr2_models_dir,
            debug=debug,
            ctx=ctx,
            dit_cache=False,
            vae_cache=False,
            dit_id="ae_dit",
            vae_id="ae_vae",
            block_swap_config=block_swap_config,
            encode_tiled=args.encode_tiled,
            encode_tile_size=(args.encode_tile_size, args.encode_tile_size),
            encode_tile_overlap=(args.encode_tile_overlap, args.encode_tile_overlap),
            decode_tiled=args.decode_tiled,
            decode_tile_size=(args.decode_tile_size, args.decode_tile_size),
            decode_tile_overlap=(args.decode_tile_overlap, args.decode_tile_overlap),
            tile_debug="false",
            attention_mode=attention_mode,
            torch_compile_args_dit=None,
            torch_compile_args_vae=None,
        )
        ctx["cache_context"] = cache_context

        # Load text embeddings (pos/neg from .pt files in node dir)
        write_status(args.status, {"status": "processing", "progress": "Loading embeddings…"})
        ctx["text_embeds"] = load_text_embeddings(
            script_directory, ctx["dit_device"], ctx["compute_dtype"], debug
        )

        # compute_generation_info prepares batches and resolution
        write_status(args.status, {"status": "processing", "progress": "Preparing batches…"})
        images_proc, gen_info = compute_generation_info(
            ctx=ctx,
            images=images,
            resolution=args.resolution,
            max_resolution=args.max_resolution,
            batch_size=args.batch_size,
            uniform_batch_size=args.uniform_batch_size,
            seed=args.seed,
            prepend_frames=args.prepend_frames,
            temporal_overlap=args.temporal_overlap,
            debug=debug,
        )

        # Log what compute_generation_info resolved
        import math
        out_H = gen_info.get("true_h", gen_info.get("output_height", orig_H))
        out_W = gen_info.get("true_w", gen_info.get("output_width",  orig_W))
        total_f = gen_info.get("total_frames", len(input_files) if args.mode == "sequence" else 1)
        n_batches = math.ceil(total_f / args.batch_size) if args.batch_size > 0 else "?"
        print(f"[SeedVR2] Output: {orig_W}x{orig_H} → {out_W}x{out_H} | {total_f} frames | {n_batches} batches x {args.batch_size}", flush=True)


        # Phase 1 — Encode
        write_status(args.status, {"status": "processing", "progress": "Phase 1/4: Encoding…"})
        ctx = encode_all_batches(
            runner, ctx=ctx, images=images_proc, debug=debug,
            batch_size=args.batch_size, uniform_batch_size=args.uniform_batch_size,
            seed=args.seed, progress_callback=None,
            temporal_overlap=args.temporal_overlap,
            resolution=args.resolution, max_resolution=args.max_resolution,
            input_noise_scale=args.input_noise_scale,
            color_correction=args.color_correction,
        )

        # Phase 2 — Upscale
        write_status(args.status, {"status": "processing", "progress": "Phase 2/4: Upscaling (DiT)…"})
        ctx = upscale_all_batches(
            runner, ctx=ctx, debug=debug, progress_callback=None,
            seed=args.seed, latent_noise_scale=args.latent_noise_scale,
            cache_model=False,
        )

        # Phase 3 — Decode
        write_status(args.status, {"status": "processing", "progress": "Phase 3/4: Decoding (VAE)…"})
        ctx = decode_all_batches(
            runner, ctx=ctx, debug=debug,
            progress_callback=None, cache_model=False,
        )

        # Phase 4 — Post-process (color correction, remove prepended frames)
        write_status(args.status, {"status": "processing", "progress": "Phase 4/4: Post-processing…"})
        ctx = postprocess_all_batches(
            ctx=ctx, debug=debug, progress_callback=None,
            color_correction=args.color_correction,
            prepend_frames=args.prepend_frames,
            temporal_overlap=args.temporal_overlap,
            batch_size=args.batch_size,
        )

        sample = ctx["final_video"]  # [N, H, W, C] float32 in [0,1]
        if sample.is_cuda or sample.is_mps:
            sample = sample.cpu()
        if sample.dtype != torch.float32:
            sample = sample.float()

        # ── Cleanup ──────────────────────────────────────────────
        try:
            complete_cleanup(runner=runner, debug=debug, dit_cache=False, vae_cache=False)
        except Exception:
            pass
        try:
            cleanup_text_embeddings(ctx, debug)
        except Exception:
            pass

        # ── Save output ──────────────────────────────────────────
        write_status(args.status, {"status": "saving", "progress": "Saving…"})
        tensor_to_images(sample, output_files)
        print(f"[SeedVR2] Saved {len(output_files)} frame(s)", flush=True)

        # Cleanup inputs if needed
        if not args.keep_input and args.mode == "single":
            try:
                if os.path.isfile(args.input): os.remove(args.input)
            except Exception: pass

        write_status(args.status, {
            "status":       "done",
            "output":       args.output,
            "mode":         args.mode,
            "total_frames": total_frames,
            "dit_model":    args.dit_model,
            "vae_model":    args.vae_model,
            "device":       args.device,
            "width":        out_W,
            "height":       out_H,
        })
        print("[SeedVR2] DONE", flush=True)

    except Exception as e:
        tb = traceback.format_exc()
        try:
            print(f"[SeedVR2] ERROR:\n{tb}", flush=True)
        except UnicodeEncodeError:
            print(tb.encode("ascii", "replace").decode("ascii"), flush=True)
        write_status(args.status, {"status": "error", "error": str(e), "traceback": tb})
        sys.exit(1)

if __name__ == "__main__":
    main()
