/*
  SeedVR2_AE.jsx — SeedVR2 AI Upscaler panel for After Effects
  Supports single images and PNG sequences.
  Uses the same pipeline as the ComfyUI node.
*/

(function(thisObj) {
    var NAME       = "SeedVR2 Upscaler";
    var VERSION    = "1.0";
    var IS_WIN     = ($.os.indexOf("Windows") !== -1);
    var SEP        = IS_WIN ? "\\" : "/";
    var SCRIPT_DIR = new File($.fileName).parent.fsName;
    var SERVER_DIR = new Folder(SCRIPT_DIR + SEP + ".." + SEP + "server").fsName;
    var PROCESS_PY = SERVER_DIR + SEP + "seedvr2_process.py";
    var TMP_DIR    = Folder.temp.fsName + SEP + "seedvr2_ae";
    var CONFIG_PATH = SERVER_DIR + SEP + "seedvr2_config.json";

    var STATIC_EXTS = /\.(png|jpg|jpeg|tif|tiff|bmp)$/i;

    var DEFAULT_COMFYUI = IS_WIN
        ? "D:\\NewComfy\\ComfyUI-Easy-Install\\ComfyUI"
        : "~/ComfyUI";

    // ── Persistence ───────────────────────────────────────────
    function loadConfig() {
        try {
            var f = new File(CONFIG_PATH);
            if (f.exists) {
                f.encoding = "UTF-8"; f.open("r");
                var d = JSON.parse(f.read()); f.close();
                return d;
            }
        } catch(e) {}
        return {};
    }
    function saveConfig(data) {
        try {
            var f = new File(CONFIG_PATH);
            f.encoding = "UTF-8"; f.open("w");
            f.write(JSON.stringify(data, null, 2)); f.close();
        } catch(e) {}
    }

    // ── Utilities ─────────────────────────────────────────────
    function ensureDir(p) { var f=new Folder(p); if(!f.exists)f.create(); return p; }

    function cleanTmpDir() {
        var folder = new Folder(TMP_DIR);
        if (!folder.exists) return;
        var files = folder.getFiles();
        var pat = /^(input_|status_|log_|svr_|run_)/;
        for (var i = 0; i < files.length; i++) {
            try { if (files[i] instanceof File && pat.test(files[i].name)) files[i].remove(); } catch(e) {}
        }
    }

    function readJSON(path) {
        var f = new File(path);
        if (!f.exists) return null;
        f.encoding = "UTF-8"; f.open("r");
        var t = f.read(); f.close();
        try { return JSON.parse(t); } catch(e) { return null; }
    }

    function copyFileSafe(src, dst) {
        if (!new File(src).copy(new File(dst)))
            throw new Error("Cannot copy: " + src);
    }

    function activeComp() {
        var c = app.project.activeItem;
        if (!c || !(c instanceof CompItem))
            throw new Error("No active composition.");
        return c;
    }

    function selectedLayer() {
        var comp = activeComp();
        if (comp.selectedLayers.length === 0)
            throw new Error("No layer selected.\nSelect a layer in the composition.");
        return comp.selectedLayers[0];
    }

    function staticSourceFile(layer) {
        try {
            var src = layer.source;
            if (src && src instanceof FootageItem && src.file) {
                var f = src.file;
                if (f instanceof File && f.exists && STATIC_EXTS.test(f.name)) return f;
            }
        } catch(e) {}
        return null;
    }

    function isImageSequence(layer) {
        try {
            var src = layer.source;
            if (!(src instanceof FootageItem) || !src.file) return false;
            var nFrames = Math.round(src.duration * (src.frameRate || 25));
            return nFrames > 1 && STATIC_EXTS.test(src.file.name);
        } catch(e) { return false; }
    }

    function getSequenceInfo(layer) {
        try {
            var src = layer.source;
            var f = src.file;
            var ext = f.name.match(/\.[^.]+$/)[0];
            return { folder: f.parent.fsName, pattern: "*" + ext };
        } catch(e) { return null; }
    }

    function findPython(comfyuiPath) {
        var candidates = IS_WIN ? [
            comfyuiPath + "\\..\\python_embeded\\python.exe",
            comfyuiPath + "\\python_embeded\\python.exe",
        ] : [
            comfyuiPath + "/venv/bin/python",
            comfyuiPath + "/venv/bin/python3",
            "/usr/bin/python3",
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (new File(candidates[i]).exists) return new File(candidates[i]).fsName;
        }
        throw new Error("Python not found near: " + comfyuiPath);
    }

    function getModelDir(comfyuiPath, subfolder) {
        return comfyuiPath + SEP + "models" + SEP + subfolder;
    }

    // ── Job / polling ─────────────────────────────────────────
    var _job = null;

    function startPolling() {
        $.global["__svr2_poll"] = _poll;
        app.scheduleTask("__svr2_poll()", 2000, false);
    }

    function _poll() {
        if (!_job) return;
        var st = readJSON(_job.statusPath);
        if (!st) {
            _job.log("     …starting Python…");
            startPolling(); return;
        }
        _job.log("     Python: [" + st.status + "]  " + (st.progress || ""));

        if (st.status === "done") {
            var job = _job; _job = null;
            _importResult(job, st);
        } else if (st.status === "error") {
            var job2 = _job; _job = null;
            var detail = st.error || "unknown error";
            var logContent = "";
            try {
                var lf = new File(job2.logPath);
                if (lf.exists) {
                    lf.encoding = "UTF-8"; lf.open("r");
                    logContent = lf.read(); lf.close();
                    if (logContent.length > 1200)
                        logContent = "…\n" + logContent.substring(logContent.length - 1200);
                }
            } catch(e) {}
            try { new File(job2.statusPath).remove(); } catch(e) {}
            try { new File(job2.logPath).remove();    } catch(e) {}
            try { if (job2.input) new File(job2.input).remove(); } catch(e) {}
            job2.onError(detail + (logContent ? "\n\n--- Python Log ---\n" + logContent : ""));
        } else {
            startPolling();
        }
    }

    function _importResult(job, st) {
        try {
            try { new File(job.statusPath).remove(); } catch(e) {}
            try { new File(job.logPath).remove();    } catch(e) {}
            try { if (job.input) new File(job.input).remove(); } catch(e) {}

            if (job.isSequence) {
                var outFolder = new Folder(job.outputDir);
                var pngFiles  = outFolder.getFiles("*.png");
                if (!pngFiles || pngFiles.length === 0)
                    throw new Error("No PNG found in output folder:\n" + job.outputDir);

                pngFiles.sort(function(a,b){ return a.name > b.name ? 1 : -1; });

                app.beginUndoGroup("SeedVR2 Upscale Sequence");
                var io = new ImportOptions(pngFiles[0]);
                io.importAs = ImportAsType.FOOTAGE;
                io.sequence = true;
                var footage = app.project.importFile(io);
                footage.name = job.layer.name + " [Upscaled]";
                try { footage.mainSource.conformFrameRate = job.comp.frameRate; } catch(e) {}

                var newLyr = job.comp.layers.add(footage);
                newLyr.startTime = job.layer.startTime;
                try { newLyr.outPoint = job.layer.outPoint; } catch(e) {}
                newLyr.moveAfter(job.layer);
                app.endUndoGroup();

                job.onDone(footage.name,
                    (st.total_frames || "?") + " frames · " +
                    (st.dit_model || "?") + " · " + (st.device || "?"));

            } else {
                var outFile = new File(job.outputPath);
                if (!outFile.exists)
                    throw new Error("Output file not found:\n" + job.outputPath);

                app.beginUndoGroup("SeedVR2 Upscale");
                var footage = app.project.importFile(new ImportOptions(outFile));
                footage.name = job.layer.name + " [Upscaled]";
                var newLyr = job.comp.layers.add(footage);
                newLyr.startTime = job.layer.startTime;
                try { newLyr.outPoint = job.layer.outPoint; } catch(e) {}
                newLyr.moveAfter(job.layer);
                app.endUndoGroup();

                job.onDone(footage.name,
                    (st.dit_model || "?") + " · " +
                    (st.width || "?") + "x" + (st.height || "?") + " · " + (st.device || "?"));
            }
        } catch(e) {
            try { app.endUndoGroup(); } catch(ee) {}
            job.onError("Import failed: " + e.message);
        }
    }

    // ── Launch ────────────────────────────────────────────────
    function launchVBS(jobData, logPath) {
        if (!IS_WIN) {
            // macOS — simple sh launcher
            var shPath = TMP_DIR + "/svr2_" + new Date().getTime() + ".sh";
            var sf = new File(shPath);
            sf.encoding = "UTF-8"; sf.open("w");
            sf.writeln("#!/bin/sh");
            sf.writeln('"' + jobData.python_exe + '" "' + PROCESS_PY + '" ' +
                       jobData.argStr + ' >> "' + logPath + '" 2>&1 &');
            sf.close();
            new File(shPath).execute();
            return;
        }

        var batPath = TMP_DIR + "\\svr2_" + new Date().getTime() + ".bat";
        var bf = new File(batPath);
        bf.encoding = "UTF-8"; bf.open("w");
        bf.writeln("@echo off");
        bf.writeln("chcp 65001 >nul");
        bf.writeln('set "PYTHONUTF8=1"');
        bf.writeln('set "PYTHONIOENCODING=utf-8"');
        bf.writeln('set "PYEXE=' + jobData.python_exe + '"');
        bf.writeln('set "PYSCRIPT=' + PROCESS_PY + '"');
        bf.writeln('start /B "" "%PYEXE%" "%PYSCRIPT%" ' + jobData.argStr +
                   ' >> "' + logPath + '" 2>&1');
        bf.close();

        var vbsPath = TMP_DIR + "\\run_" + new Date().getTime() + ".vbs";
        var bp = batPath.replace(/\\/g, "\\\\");
        var vp = vbsPath.replace(/\\/g, "\\\\");
        var vf = new File(vbsPath);
        vf.encoding = "UTF-8"; vf.open("w");
        vf.writeln('Set sh  = CreateObject("WScript.Shell")');
        vf.writeln('Set fso = CreateObject("Scripting.FileSystemObject")');
        vf.writeln('sh.Run "cmd /C """ & "' + bp + '" & """", 0, True');
        vf.writeln('On Error Resume Next');
        vf.writeln('fso.DeleteFile "' + bp + '"');
        vf.writeln('fso.DeleteFile "' + vp + '"');
        vf.close();
        new File(vbsPath).execute();
    }

    // ── Build argStr ──────────────────────────────────────────
    function buildArgStr(p) {
        var parts = [
            '--comfyui "'          + p.comfyui + '"',
            '--dit_model "'        + p.dit_model + '"',
            '--vae_model "'        + p.vae_model + '"',
            '--status "'           + p.status + '"',
            '--device "'           + p.device + '"',
            '--seed '              + (p.seed || 42),
            '--resolution '        + (parseInt(p.resolution,10) || 0),
            '--max_resolution '    + (parseInt(p.maxResolution,10) || 1920),
            '--batch_size '        + (parseInt(p.batchSize,10) || 1),
            '--color_correction '  + (p.colorCorrection || 'lab'),
            '--temporal_overlap '  + (parseInt(p.temporalOverlap,10) || 0),
            '--blocks_to_swap '    + (parseInt(p.blocksToSwap,10) || 35),
            '--attention_mode '    + (p.attentionMode || 'auto'),
            '--encode_tile_size '  + (parseInt(p.encodeTileSize,10) || 1024),
            '--encode_tile_overlap ' + (parseInt(p.encodeTileOverlap,10) || 128),
            '--decode_tile_size '  + (parseInt(p.decodeTileSize,10) || 768),
            '--decode_tile_overlap ' + (parseInt(p.decodeTileOverlap,10) || 128),
        ];
        if (p.uniformBatchSize) parts.push('--uniform_batch_size');
        if (p.mode === "sequence") {
            parts.push('--mode sequence');
            parts.push('--input "'  + p.input_dir + '"');
            parts.push('--output "' + p.output_dir + '"');
            parts.push('--pattern "' + p.pattern + '"');
        } else {
            parts.push('--mode single');
            parts.push('--input "'  + p.input + '"');
            parts.push('--output "' + p.output + '"');
        }
        if (p.encodeTiled)  parts.push("--encode_tiled");
        if (p.decodeTiled)  parts.push("--decode_tiled");
        if (p.keep_input)   parts.push("--keep_input");
        if (p.offloadDevice && p.offloadDevice !== "none")
            parts.push('--offload_device ' + p.offloadDevice);
        if (p.pid_file) parts.push('--pid_file "' + p.pid_file + '"');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            if (parts[i] !== '') out.push(parts[i]);
        }
        return out.join(" ");
    }

    // ── Main processing ───────────────────────────────────────
    function startProcessing(params, log, onDone, onError) {
        try {
            var cp = params.comfyuiPath;
            if (!cp || !new Folder(cp).exists)
                throw new Error("Invalid ComfyUI path:\n" + cp);

            var pythonExe = findPython(cp);
            log("     Python: " + pythonExe);
            log("     ComfyUI: " + cp);
            log("     DiT: " + params.ditModel);
            log("     VAE: " + params.vaeModel);

            if (!new File(PROCESS_PY).exists)
                throw new Error("seedvr2_process.py not found:\n" + PROCESS_PY);

            ensureDir(TMP_DIR);
            var ts = String(new Date().getTime());
            var statusPath = TMP_DIR + SEP + "status_" + ts + ".json";
            var logPath    = TMP_DIR + SEP + "log_"    + ts + ".txt";
            var inputPath  = TMP_DIR + SEP + "input_"  + ts + ".png";
            var pidPath    = TMP_DIR + SEP + "pid_"    + ts + ".txt";

            var comp  = activeComp();
            var layer = selectedLayer();

            var outputDir = TMP_DIR;
            var projectFile = app.project.file;
            if (projectFile && projectFile instanceof File && projectFile.exists) {
                var svr2Folder = new Folder(projectFile.parent.fsName + SEP + "SeedVR2");
                if (!svr2Folder.exists) svr2Folder.create();
                outputDir = svr2Folder.fsName;
                log("     Output: " + outputDir);
            } else {
                log("     ⚠ Project not saved — output in temp folder.");
            }

            var safeName = layer.name
                .replace(/[\/\\:*?"<>|%]/g, "_")
                .replace(/\.png$/i, "")
                .replace(/\./g, "_");
            if (safeName.length > 35) safeName = safeName.substring(0, 35);

            log("     Layer: " + layer.name);

            var sf    = staticSourceFile(layer);
            var isSeq = isImageSequence(layer);

            if (isSeq) {
                var seqInfo = getSequenceInfo(layer);
                if (!seqInfo) throw new Error("Cannot read sequence.");
                var srcFolderName = new Folder(seqInfo.folder).name.substring(0, 25);
                var seqOutDir = outputDir + SEP + srcFolderName + "_Up_" + ts;
                log("     Sequence: " + seqInfo.folder);

                var argStr = buildArgStr({
                    comfyui: cp, dit_model: params.ditModel, vae_model: params.vaeModel,
                    status: statusPath, device: params.device, seed: params.seed,
                    resolution: params.resolution, maxResolution: params.maxResolution,
                    batchSize: params.batchSize, attentionMode: params.attentionMode, colorCorrection: params.colorCorrection,
                    temporalOverlap: params.temporalOverlap,
                    encodeTileSize: params.encodeTileSize, encodeTileOverlap: params.encodeTileOverlap,
                    decodeTileSize: params.decodeTileSize, decodeTileOverlap: params.decodeTileOverlap,
                    encodeTiled: params.encodeTiled, decodeTiled: params.decodeTiled, keep_input: true,
                    mode: "sequence", input_dir: seqInfo.folder,
                    output_dir: seqOutDir, pattern: seqInfo.pattern,
                    pid_file: pidPath,
                });

                launchVBS({python_exe: pythonExe, argStr: argStr}, logPath);
                log("     Launching Python (background)…");
                log("     Python log: " + logPath);

                _job = {
                    statusPath: statusPath, logPath: logPath, input: null,
                    pidPath: pidPath,
                    outputDir: seqOutDir, comp: comp, layer: layer,
                    isSequence: true, log: log, onDone: onDone, onError: onError,
                };

            } else if (sf) {
                var ext = sf.name.match(/\.[^.]+$/)[0].toLowerCase();
                inputPath = TMP_DIR + SEP + "input_" + ts + ext;
                copyFileSafe(sf.fsName, inputPath);
                log("     Image: " + sf.name + "  (" + sf.length + " bytes)");

                var outputPath = outputDir + SEP + safeName + "_Up_" + ts + ".png";

                var argStr = buildArgStr({
                    comfyui: cp, dit_model: params.ditModel, vae_model: params.vaeModel,
                    status: statusPath, device: params.device, seed: params.seed,
                    resolution: params.resolution, maxResolution: params.maxResolution,
                    batchSize: params.batchSize, attentionMode: params.attentionMode, colorCorrection: params.colorCorrection,
                    temporalOverlap: params.temporalOverlap,
                    encodeTileSize: params.encodeTileSize, encodeTileOverlap: params.encodeTileOverlap,
                    decodeTileSize: params.decodeTileSize, decodeTileOverlap: params.decodeTileOverlap,
                    encodeTiled: params.encodeTiled, decodeTiled: params.decodeTiled, keep_input: false,
                    mode: "single", input: inputPath, output: outputPath,
                    pid_file: pidPath,
                });

                launchVBS({python_exe: pythonExe, argStr: argStr}, logPath);
                log("     Launching Python (background)…");
                log("     Python log: " + logPath);

                _job = {
                    statusPath: statusPath, logPath: logPath, input: inputPath,
                    pidPath: pidPath,
                    outputPath: outputPath, comp: comp, layer: layer,
                    isSequence: false, log: log, onDone: onDone, onError: onError,
                };

            } else {
                throw new Error(
                    "Video layers (.mp4, .mov, etc.) are not supported directly.\n\n" +
                    "Export your video as a PNG sequence first:\n" +
                    "1. Select the video layer\n" +
                    "2. File → Export → Add to Render Queue\n" +
                    "3. Output Module → Format: PNG Sequence\n" +
                    "4. Render → import the PNG sequence\n" +
                    "5. Select the PNG sequence layer and run this script"
                );
            }

            startPolling();

        } catch(e) {
            onError(e.message || String(e));
        }
    }

    // ── UI ────────────────────────────────────────────────────
    function buildUI(host) {
        var cfg = loadConfig();

        var win = (host instanceof Panel)
            ? host
            : new Window("palette", NAME + " v" + VERSION, undefined, {resizeable: true});

        win.orientation   = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing       = 4;
        win.margins       = 8;
        win.minimumSize   = [280, 500];

        // ── Configuration ─────────────────────────────────────
        var cfgPnl = win.add("panel", undefined, "Configuration");
        cfgPnl.orientation = "column"; cfgPnl.alignChildren = ["fill","top"];
        cfgPnl.margins = [8,14,8,8]; cfgPnl.spacing = 6;

        cfgPnl.add("statictext", undefined, "ComfyUI root:");
        var cpRow = cfgPnl.add("group");
        cpRow.orientation = "row"; cpRow.alignChildren = ["fill","center"]; cpRow.spacing = 4;
        var cpInput = cpRow.add("edittext", undefined, cfg.comfyuiPath || DEFAULT_COMFYUI);
        cpInput.alignment = ["fill","center"]; cpInput.minimumSize = [60,20];
        var cpBtn = cpRow.add("button", undefined, "…");
        cpBtn.preferredSize = [28,22]; cpBtn.maximumSize = [28,22];
        cpBtn.onClick = function() {
            var f = Folder.selectDialog("Select ComfyUI root folder");
            if (f) {
                cpInput.text = f.fsName;
                refreshModelLists();
                saveConfig({comfyuiPath: f.fsName,
                    ditModel: ditDrop.selection ? ditDrop.selection.text : "",
                    vaeModel: vaeDrop.selection ? vaeDrop.selection.text : ""});
            }
        };

        // DiT model dropdown
        cfgPnl.add("statictext", undefined, "DiT model:");
        var ditRow = cfgPnl.add("group");
        ditRow.orientation = "row"; ditRow.alignChildren = ["fill","center"]; ditRow.spacing = 4;
        var ditDrop = ditRow.add("dropdownlist", undefined, ["(no models found)"]);
        ditDrop.alignment = ["fill","center"]; ditDrop.selection = 0;
        var ditRefBtn = ditRow.add("button", undefined, "↺");
        ditRefBtn.preferredSize = [28,22]; ditRefBtn.maximumSize = [28,22];
        ditRefBtn.onClick = function() { refreshModelLists(); };

        // VAE model dropdown
        cfgPnl.add("statictext", undefined, "VAE model:");
        var vaeRow = cfgPnl.add("group");
        vaeRow.orientation = "row"; vaeRow.alignChildren = ["fill","center"]; vaeRow.spacing = 4;
        var vaeDrop = vaeRow.add("dropdownlist", undefined, ["(no models found)"]);
        vaeDrop.alignment = ["fill","center"]; vaeDrop.selection = 0;
        var vaeRefBtn = vaeRow.add("button", undefined, "↺");
        vaeRefBtn.preferredSize = [28,22]; vaeRefBtn.maximumSize = [28,22];
        vaeRefBtn.onClick = function() { refreshModelLists(); };

        function populateDrop(drop, files, savedName) {
            while (drop.items.length > 0) drop.remove(0);
            if (!files || files.length === 0) {
                drop.add("item", "(no models found)");
            } else {
                for (var i = 0; i < files.length; i++) drop.add("item", files[i].name);
                // Default DiT to 7b model if no saved preference
                var defaultName = savedName;
                if (!defaultName && drop === ditDrop) {
                    for (var d = 0; d < drop.items.length; d++) {
                        if (drop.items[d].text.indexOf("7b") !== -1) { defaultName = drop.items[d].text; break; }
                    }
                }
                drop.selection = 0;
                for (var k = 0; k < drop.items.length; k++) {
                    if (drop.items[k].text === defaultName) { drop.selection = k; break; }
                }
            }
            try { drop.update(); } catch(e) {}
        }

        function refreshModelLists() {
            var cp = cpInput.text;
            // Try both casings
            var modelsFolder = new Folder(cp + SEP + "models" + SEP + "SEEDVR2");
            if (!modelsFolder.exists)
                modelsFolder = new Folder(cp + SEP + "models" + SEP + "SeedVR2");
            var allFiles = modelsFolder.exists
                ? modelsFolder.getFiles(/\.(safetensors|pth|gguf)$/i)
                : [];
            if (allFiles) allFiles.sort(function(a,b){ return a.name>b.name?1:-1; });

            // DiT = contiene "seedvr2" e NON "vae"
            var ditFiles = [], vaeFiles = [], otherFiles = [];
            for (var i = 0; i < allFiles.length; i++) {
                var n = allFiles[i].name.toLowerCase();
                if (n.indexOf("vae") !== -1) {
                    vaeFiles.push(allFiles[i]);
                } else if (n.indexOf("seedvr2") !== -1 || n.indexOf("dit") !== -1) {
                    ditFiles.push(allFiles[i]);
                } else {
                    otherFiles.push(allFiles[i]);
                }
            }
            // Se nessun DiT trovato con filtro, mostra tutti i non-VAE
            if (ditFiles.length === 0) ditFiles = otherFiles;

            populateDrop(ditDrop, ditFiles,  cfg.ditModel || "");
            populateDrop(vaeDrop, vaeFiles.length > 0 ? vaeFiles : allFiles, cfg.vaeModel || "");
        }
        refreshModelLists();
        cleanTmpDir();

        // ── Output info ───────────────────────────────────────
        var outPnl = win.add("panel", undefined, "Output folder");
        outPnl.orientation = "column"; outPnl.alignChildren = ["fill","top"];
        outPnl.margins = [8,14,8,8]; outPnl.spacing = 2;
        var outLbl = outPnl.add("statictext", undefined, "Save the .aep project first", {multiline:true});
        outLbl.alignment = ["fill","top"]; outLbl.minimumSize = [60,28];

        function refreshOutputPath() {
            var pf = app.project.file;
            outLbl.text = (pf && pf instanceof File && pf.exists)
                ? pf.parent.fsName + "/SeedVR2/"
                : "⚠ Not saved — output in temp folder";
        }
        refreshOutputPath();

        // ── Parameters ────────────────────────────────────────
        var pp = win.add("panel", undefined, "Parameters");
        pp.orientation = "column"; pp.alignChildren = ["fill","top"];
        pp.margins = [8,14,8,8]; pp.spacing = 5;

        function labeledRow(parent, labelText) {
            var g = parent.add("group");
            g.orientation = "row"; g.alignChildren = ["fill","center"]; g.spacing = 6;
            var lbl = g.add("statictext", undefined, labelText);
            lbl.preferredSize.width = 108; lbl.alignment = ["left","center"];
            return g;
        }

        // Resolution
        var resRow = labeledRow(pp, "Max resolution:");
        var resEt  = resRow.add("edittext", undefined, "1920");
        resEt.alignment = ["fill","center"];
        resEt.helpTip = "Maximum resolution for any edge — image is scaled up to fit without exceeding this";

        // Color correction
        var ccRow  = labeledRow(pp, "Color correct:");
        var ccDrop = ccRow.add("dropdownlist", undefined,
            ["lab","wavelet","wavelet_adaptive","hsv","adain","none"]);
        ccDrop.selection = 0; ccDrop.alignment = ["fill","center"];

        // Batch size (4n+1 values)
        var batchRow  = labeledRow(pp, "Batch size:");
        var batchDrop = batchRow.add("dropdownlist", undefined,
            ["1","5","9","13","17","21","25","29","33","37","41","45","49","53","57","61","65"]);
        batchDrop.selection = 8; batchDrop.alignment = ["fill","center"];
        batchDrop.helpTip = "Frames per batch (4n+1 pattern)\nHigher = better temporal consistency, more VRAM\n1 = single image / low VRAM";

        // Uniform batch size
        var ubsRow = pp.add("group");
        ubsRow.alignChildren = ["left","center"]; ubsRow.spacing = 8;
        ubsRow.add("statictext", undefined, "Uniform batch:").preferredSize.width = 108;
        var ubsCb = ubsRow.add("checkbox");
        ubsCb.value = true;
        ubsRow.add("statictext", undefined, "(pad final batch)");
        ubsCb.helpTip = "Pad final batch to match batch size\nPrevents temporal artifacts at end of sequence";

        // Temporal overlap
        var toRow  = labeledRow(pp, "Temporal overlap:");
        var toDrop = toRow.add("dropdownlist", undefined,
            ["0","1","2","4","8","16"]);
        toDrop.selection = 3; toDrop.alignment = ["fill","center"];
        toDrop.helpTip = "Overlapping frames between batches\nImproves consistency across batch boundaries\n0 = disabled (use for single images)";

        // Seed
        var seedRow = labeledRow(pp, "Seed:");
        var seedEt  = seedRow.add("edittext", undefined, "42");
        seedEt.alignment = ["fill","center"];

        // Tile sizes — encode and decode separate (like ComfyUI node)
        var encTileRow  = labeledRow(pp, "Enc tile size:");
        var encTileDrop = encTileRow.add("dropdownlist", undefined,
            ["512","768","1024","1280","1536"]);
        encTileDrop.selection = 2; encTileDrop.alignment = ["fill","center"];
        encTileDrop.helpTip = "VAE encode tile size (default: 1024)";

        var encOvRow  = labeledRow(pp, "Enc tile overlap:");
        var encOvDrop = encOvRow.add("dropdownlist", undefined,
            ["64","96","128","192","256"]);
        encOvDrop.selection = 2; encOvDrop.alignment = ["fill","center"];
        encOvDrop.helpTip = "VAE encode tile overlap (default: 128)";

        var decTileRow  = labeledRow(pp, "Dec tile size:");
        var decTileDrop = decTileRow.add("dropdownlist", undefined,
            ["512","768","1024","1280","1536"]);
        decTileDrop.selection = 1; decTileDrop.alignment = ["fill","center"];  // default 768
        decTileDrop.helpTip = "VAE decode tile size (default: 768)";

        var decOvRow  = labeledRow(pp, "Dec tile overlap:");
        var decOvDrop = decOvRow.add("dropdownlist", undefined,
            ["64","96","128","192","256"]);
        decOvDrop.selection = 2; decOvDrop.alignment = ["fill","center"];
        decOvDrop.helpTip = "VAE decode tile overlap (default: 128)";

        // BlockSwap
        var bsRow  = labeledRow(pp, "Block swap:");
        var bsSl   = bsRow.add("slider", undefined, 35, 0, 36);
        bsSl.alignment = ["fill","center"];
        var bsLbl  = bsRow.add("statictext", undefined, "35");
        bsLbl.preferredSize.width = 24;
        bsSl.onChanging = function() { bsLbl.text = String(Math.round(bsSl.value)); };
        bsSl.helpTip = "Transformer blocks offloaded to CPU (0=all on GPU, 35=ComfyUI default)";

        // Attention mode
        var attnRow  = labeledRow(pp, "Attention:");
        var attnDrop = attnRow.add("dropdownlist", undefined,
            ["auto","sageattn_2","sdpa","flash_attn","sageattn_3"]);
        attnDrop.selection = 0; attnDrop.alignment = ["fill","center"];
        attnDrop.helpTip = "auto = detects best option automatically (recommended)\nsdpa = always available but slow first batch";

        // Encode/Decode tiling checkboxes
        var encRow = pp.add("group");
        encRow.alignChildren = ["left","center"]; encRow.spacing = 8;
        encRow.add("statictext", undefined, "Tiling:").preferredSize.width = 108;
        var encCb = encRow.add("checkbox", undefined, "Encode");
        encCb.value = true;
        var decCb = encRow.add("checkbox", undefined, "Decode");
        decCb.value = true;

        // Offload device
        var offRow  = labeledRow(pp, "Offload device:");
        var offDrop = offRow.add("dropdownlist", undefined, ["none (fastest)", "cpu (safe)"]);
        offDrop.selection = 1; offDrop.alignment = ["fill","center"];
        offDrop.helpTip = "none = keep everything on GPU (fast, needs more VRAM)\ncpu = offload between phases (slower, safer on low VRAM)";

        // ── Presets ────────────────────────────────────────────
        var presetPnl = win.add("panel", undefined, "Preset");
        presetPnl.orientation = "row"; presetPnl.alignChildren = ["fill","center"];
        presetPnl.margins = [8,14,8,8]; presetPnl.spacing = 6;
        var btnPresetVideo = presetPnl.add("button", undefined, "🎬 Video");
        btnPresetVideo.alignment = ["fill","center"];
        var btnPresetImage = presetPnl.add("button", undefined, "🖼 Single Image");
        btnPresetImage.alignment = ["fill","center"];

        btnPresetVideo.onClick = function() {
            batchDrop.selection = 8;    // 33
            ubsCb.value          = true;
            toDrop.selection     = 3;   // 4
            encCb.value          = true;
            decCb.value          = true;
            offDrop.selection    = 1;   // cpu
            encTileDrop.selection = 2;  // 1024
            encOvDrop.selection   = 2;  // 128
            decTileDrop.selection = 1;  // 768
            decOvDrop.selection   = 2;  // 128
            bsSl.value = 35; bsLbl.text = "35";
                    attnDrop.selection = 0;  // sageattn_2
        };

        btnPresetImage.onClick = function() {
            batchDrop.selection = 0;    // 1
            ubsCb.value          = false;
            toDrop.selection     = 0;   // 0
            encCb.value          = true;
            decCb.value          = true;
            offDrop.selection    = 1;   // cpu
            encTileDrop.selection = 2;  // 1024
            encOvDrop.selection   = 2;  // 128
            decTileDrop.selection = 1;  // 768
            decOvDrop.selection   = 2;  // 128
            bsSl.value = 35; bsLbl.text = "35";
                    attnDrop.selection = 0;  // sageattn_2
        };

        // ── Progress / button ─────────────────────────────────
        var progLbl = win.add("statictext", undefined, "Ready.", {multiline:true});
        progLbl.alignment = ["fill","top"]; progLbl.minimumSize = [60,28];

        var btnRow = win.add("group");
        btnRow.orientation = "row"; btnRow.alignChildren = ["fill","center"]; btnRow.spacing = 6;
        var btnProc = btnRow.add("button", undefined, "▶  Upscale");
        btnProc.alignment = ["fill","center"]; btnProc.preferredSize.height = 28;
        var btnStop = btnRow.add("button", undefined, "■ Stop");
        btnStop.preferredSize = [60, 28]; btnStop.enabled = false;

        // ── Log ────────────────────────────────────────────────
        var logPnl = win.add("panel", undefined, "Log");
        logPnl.alignment = ["fill","fill"]; logPnl.alignChildren = ["fill","fill"];
        logPnl.margins = [6,14,6,6];
        var logBox = logPnl.add("edittext", undefined, "",
            {multiline:true, scrollable:true});
        logBox.alignment = ["fill","fill"]; logBox.minimumSize = [60,40];

        // Signature
        var sigLbl = win.add("statictext", undefined, "ComfyUI ──▶ AE  |  SeedVR2 AE  |  @digigabbo");
        sigLbl.alignment = ["fill","bottom"];
        sigLbl.justify   = "center";
        try { sigLbl.graphics.foregroundColor = sigLbl.graphics.newPen(
            sigLbl.graphics.PenType.SOLID_COLOR, [0.2, 0.5, 1.0, 1], 1); } catch(e) {}

        function p2(n){ return n<10?"0"+n:String(n); }
        function ts(){ var d=new Date(); return p2(d.getHours())+":"+p2(d.getMinutes())+":"+p2(d.getSeconds()); }
        var _logLines = [];
        var _LOG_MAX  = 2;
        function alog(msg) {
            _logLines.push("["+ts()+"] "+msg);
            if (_logLines.length > _LOG_MAX) _logLines.shift();
            logBox.text = _logLines.join("\n");
            try { logBox.update(); } catch(e) {}
        }
        function killProcess(pidFile) {
            try {
                var f = new File(pidFile);
                if (!f.exists) return false;
                f.encoding = "UTF-8"; f.open("r");
                var pid = f.read(); f.close();
                pid = pid.replace(/\s/g, "");
                if (!pid) return false;
                var vbsPath = TMP_DIR + "\\kill_" + new Date().getTime() + ".vbs";
                var vf = new File(vbsPath);
                vf.encoding = "UTF-8"; vf.open("w");
                vf.writeln('Set sh = CreateObject("WScript.Shell")');
                vf.writeln('sh.Run "taskkill /PID ' + pid + ' /F /T", 0, True');
                vf.writeln('Set fso = CreateObject("Scripting.FileSystemObject")');
                vf.writeln('On Error Resume Next');
                vf.writeln('fso.DeleteFile "' + vbsPath.replace(/\\/g,"\\\\") + '"');
                vf.close();
                new File(vbsPath).execute();
                try { f.remove(); } catch(e) {}
                return true;
            } catch(e) { return false; }
        }

        btnStop.onClick = function() {
            if (!_job) return;
            var killed = killProcess(_job.pidPath || "");
            alog(killed ? "⏹ Process stopped." : "⏹ Stop requested.");
            progLbl.text = "⏹ Stopped.";
            try { new File(_job.statusPath).remove(); } catch(e) {}
            try { new File(_job.logPath).remove();    } catch(e) {}
            try { if (_job.input) new File(_job.input).remove(); } catch(e) {}
            _job = null;
            setBusy(false);
        };

        function setBusy(busy) {
            btnProc.enabled  = !busy;
            btnStop.enabled  =  busy;
            ditDrop.enabled  = !busy;
            vaeDrop.enabled  = !busy;
            ccDrop.enabled   = !busy;
            cpInput.enabled  = !busy;
            cpBtn.enabled    = !busy;
            resEt.enabled    = !busy;
            seedEt.enabled   = !busy;
            encTileDrop.enabled = !busy;
            encOvDrop.enabled  = !busy;
            decTileDrop.enabled = !busy;
            decOvDrop.enabled  = !busy;
            encCb.enabled    = !busy;
            decCb.enabled    = !busy;
            offDrop.enabled  = !busy;
            bsSl.enabled     = !busy;
            batchDrop.enabled = !busy;
            ubsCb.enabled    = !busy;
            toDrop.enabled   = !busy;
            attnDrop.enabled       = !busy;
            btnPresetVideo.enabled = !busy;
            btnPresetImage.enabled = !busy;
        }

        btnProc.onClick = function() {
            refreshOutputPath();
            var cp = cpInput.text;
            if (!cp || !new Folder(cp).exists) {
                alert("Set the ComfyUI path first using the '…' button.", NAME); return;
            }
            var ditSel = ditDrop.selection ? ditDrop.selection.text : "";
            var vaeSel = vaeDrop.selection ? vaeDrop.selection.text : "";
            if (!ditSel || ditSel === "(no models found)") {
                alert("No DiT model found. Check models/SeedVR2/ in ComfyUI.", NAME); return;
            }
            if (!vaeSel || vaeSel === "(no models found)") {
                alert("No VAE model found. Check models/SeedVR2/ in ComfyUI.", NAME); return;
            }
            saveConfig({comfyuiPath: cp, ditModel: ditSel, vaeModel: vaeSel});

            setBusy(true);
            progLbl.text = "⏳ Processing…  AE remains usable.";
            alog("=== Starting SeedVR2 upscale ===");

            var res  = (parseInt(resEt.text, 10) || 2000);
            var seed = parseInt(seedEt.text, 10) || 42;

            startProcessing({
                comfyuiPath:       cp,
                ditModel:          ditSel,
                vaeModel:          vaeSel,
                device:            "cuda",
                seed:              seed,
                resolution:        res,
                maxResolution:     res,
                batchSize:         parseInt(batchDrop.selection.text, 10),
                uniformBatchSize:  ubsCb.value,
                colorCorrection:   ccDrop.selection.text,
                temporalOverlap:   parseInt(toDrop.selection.text, 10),
                encodeTileSize:    parseInt(encTileDrop.selection.text, 10),
                encodeTileOverlap: parseInt(encOvDrop.selection.text, 10),
                decodeTileSize:    parseInt(decTileDrop.selection.text, 10),
                decodeTileOverlap: parseInt(decOvDrop.selection.text, 10),
                encodeTiled:       encCb.value,
                decodeTiled:       decCb.value,
                offloadDevice:     offDrop.selection.index === 0 ? "none" : "cpu",
                blocksToSwap:      Math.round(bsSl.value),
                attentionMode:     attnDrop.selection.text,
            },
            alog,
            function(name, info) {
                alog("✓  " + name + "  [" + info + "]");
                progLbl.text = "✓ Done: " + name;
                refreshOutputPath();
                setBusy(false);
            },
            function(errMsg) {
                alog("✗ ERROR:\n" + errMsg);
                progLbl.text = "✗ Error — check log";
                alert(errMsg, NAME);
                setBusy(false);
                _job = null;
            });
        };

        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); win.layout.resize(); }
    }

    buildUI(thisObj);

})(this);
