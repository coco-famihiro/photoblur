import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

interface PhotoItem {
  filePath: string;
  fileName: string;
  status: "pending" | "done" | "skipped";
  willEdit: boolean;
  regions: PhotoRegion[];
}

interface PhotoRegion {
  id: string;
  type: "blur" | "mosaic_face" | "mosaic_body";
  shape: "rect" | "ellipse";
  x: number;      // 0-100 % of image
  y: number;
  width: number;
  height: number;
  intensity: number;
}

interface DrawState {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface Bounds {
  x: number; y: number; w: number; h: number;
}

// ---- canvas helpers ----

function makeShapePath(
  ctx: CanvasRenderingContext2D,
  shape: "rect" | "ellipse",
  rx: number, ry: number, rw: number, rh: number,
) {
  ctx.beginPath();
  if (shape === "ellipse") {
    ctx.ellipse(rx + rw / 2, ry + rh / 2, Math.max(1, rw / 2), Math.max(1, rh / 2), 0, 0, Math.PI * 2);
  } else {
    ctx.rect(rx, ry, rw, rh);
  }
}

function applyBlurEffect(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  r: PhotoRegion,
  b: Bounds,
  intensityOverride: number,
) {
  const rx = b.x + r.x / 100 * b.w;
  const ry = b.y + r.y / 100 * b.h;
  const rw = Math.max(1, r.width / 100 * b.w);
  const rh = Math.max(1, r.height / 100 * b.h);

  const scaleX = img.naturalWidth / b.w;
  const scaleY = img.naturalHeight / b.h;
  const srcX = (rx - b.x) * scaleX;
  const srcY = (ry - b.y) * scaleY;
  const srcW = rw * scaleX;
  const srcH = rh * scaleY;

  // Scale effect by IMAGE size (not region size) so intensity is uniform
  // regardless of how large or small the selected region is. Matches Python formula.
  const imageShort = Math.min(b.w, b.h);

  const off = document.createElement("canvas");

  if (r.type === "blur") {
    const sigma = Math.max(1, intensityOverride * imageShort / 1000);
    const padding = Math.ceil(sigma * 2.5);
    off.width = Math.ceil(rw) + padding * 2;
    off.height = Math.ceil(rh) + padding * 2;
    const offCtx = off.getContext("2d")!;
    offCtx.filter = `blur(${sigma}px)`;
    offCtx.drawImage(
      img,
      srcX - padding * scaleX, srcY - padding * scaleY,
      (rw + padding * 2) * scaleX, (rh + padding * 2) * scaleY,
      0, 0, off.width, off.height,
    );
    offCtx.filter = "none";
    ctx.save();
    makeShapePath(ctx, r.shape, rx, ry, rw, rh);
    ctx.clip();
    ctx.drawImage(off, rx - padding, ry - padding, off.width, off.height);
    ctx.restore();
    return;
  } else {
    const pixelSize = Math.max(2, Math.floor(intensityOverride * imageShort / 1000));
    const sw = Math.max(1, Math.floor(rw / pixelSize));
    const sh = Math.max(1, Math.floor(rh / pixelSize));
    off.width = Math.ceil(rw);
    off.height = Math.ceil(rh);
    const offCtx = off.getContext("2d")!;
    const tiny = document.createElement("canvas");
    tiny.width = sw; tiny.height = sh;
    const tCtx = tiny.getContext("2d")!;
    tCtx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, sw, sh);
    offCtx.imageSmoothingEnabled = false;
    offCtx.drawImage(tiny, 0, 0, sw, sh, 0, 0, Math.ceil(rw), Math.ceil(rh));
  }

  // mosaic: offscreen canvas starts at (rx, ry), no padding
  ctx.save();
  makeShapePath(ctx, r.shape, rx, ry, rw, rh);
  ctx.clip();
  ctx.drawImage(off, rx, ry, off.width, off.height);
  ctx.restore();
}

// ---- main component ----

export function PhotoBlurEditor() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [regions, setRegions] = useState<PhotoRegion[]>([]);
  const [history, setHistory] = useState<PhotoRegion[][]>([]); // undo stack
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState<"blur" | "mosaic_face" | "mosaic_body">("blur");
  const [drawShape, setDrawShape] = useState<"rect" | "ellipse">("ellipse"); // default: ellipse
  const [drawState, setDrawState] = useState<DrawState | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [outputFolder, setOutputFolder] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [blurIntensity, setBlurIntensity] = useState(7);
  const [mosaicFaceIntensity, setMosaicFaceIntensity] = useState(20);
  const [mosaicBodyIntensity, setMosaicBodyIntensity] = useState(7);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  // Stable refs for use inside callbacks with empty deps
  const photosRef = useRef<PhotoItem[]>([]);
  const regionsRef = useRef<PhotoRegion[]>([]);
  const currentIndexRef = useRef(0);
  const drawStateRef = useRef<DrawState | null>(null);

  const currentPhoto = photos[currentIndex] ?? null;
  const canSave = !!currentPhoto?.willEdit;
  const willEditCount = photos.filter(p => p.willEdit).length;
  const doneCount = photos.filter(p => p.willEdit && p.status === "done").length;
  const intensity = drawMode === "blur" ? blurIntensity
    : drawMode === "mosaic_face" ? mosaicFaceIntensity
    : mosaicBodyIntensity;

  // Keep refs in sync so stable callbacks can read latest state
  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => { regionsRef.current = regions; }, [regions]);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  useEffect(() => { drawStateRef.current = drawState; }, [drawState]);

  // Push to history before mutating regions
  const pushHistory = useCallback((currentRegions: PhotoRegion[]) => {
    setHistory(prev => [...prev, currentRegions]);
  }, []);

  const handleUndo = useCallback(() => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const restored = next.pop()!;
      setRegions(restored);
      setSelectedId(null);
      return next;
    });
  }, []);

  // Image bounds (letterbox centering inside canvas)
  const getImageBounds = useCallback((): Bounds | null => {
    const canvas = canvasRef.current;
    if (!canvas || !imgNatural) return null;
    const { w: iw, h: ih } = imgNatural;
    const cw = canvas.width;
    const ch = canvas.height;
    if (!cw || !ch || !iw || !ih) return null;
    const scale = Math.min(cw / iw, ch / ih);
    const rw = iw * scale;
    const rh = ih * scale;
    return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
  }, [imgNatural]);

  const canvasToPercent = useCallback((cx: number, cy: number) => {
    const b = getImageBounds();
    if (!b) return null;
    return {
      x: Math.max(0, Math.min(100, (cx - b.x) / b.w * 100)),
      y: Math.max(0, Math.min(100, (cy - b.y) / b.h * 100)),
    };
  }, [getImageBounds]);

  // Sync canvas size to container
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      scheduleRender();
    });
    ro.observe(container);
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render: photo + effects only (no labels, no borders)
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const b = getImageBounds();
    if (!b || !img || img.naturalWidth === 0) return;

    // Draw base photo
    ctx.drawImage(img, b.x, b.y, b.w, b.h);

    // Apply effects (no border, no label)
    for (const r of regions) {
      const eff = r.type === "blur" ? blurIntensity
        : r.type === "mosaic_face" ? mosaicFaceIntensity
        : mosaicBodyIntensity;
      applyBlurEffect(ctx, img, r, b, eff);
    }

    // Highlight selected region with a subtle outline only
    if (selectedId) {
      const r = regions.find(x => x.id === selectedId);
      if (r) {
        const rx = b.x + r.x / 100 * b.w;
        const ry = b.y + r.y / 100 * b.h;
        const rw = r.width / 100 * b.w;
        const rh = r.height / 100 * b.h;
        makeShapePath(ctx, r.shape, rx, ry, rw, rh);
        ctx.strokeStyle = "#ffdd00";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // In-progress drawing shape (dashed outline only)
    if (drawState) {
      const rx = b.x + Math.min(drawState.startX, drawState.endX) / 100 * b.w;
      const ry = b.y + Math.min(drawState.startY, drawState.endY) / 100 * b.h;
      const rw = Math.abs(drawState.endX - drawState.startX) / 100 * b.w;
      const rh = Math.abs(drawState.endY - drawState.startY) / 100 * b.h;
      makeShapePath(ctx, drawShape, rx, ry, rw, rh);
      ctx.strokeStyle = drawMode === "blur" ? "#88aaff"
        : drawMode === "mosaic_face" ? "#ff88aa" : "#88ffaa";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [regions, selectedId, drawState, drawMode, drawShape, blurIntensity, mosaicFaceIntensity, mosaicBodyIntensity, getImageBounds]);

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => render());
  }, [render]);

  useEffect(() => { scheduleRender(); }, [scheduleRender]);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  useEffect(() => { scheduleRender(); }, [imgNatural, scheduleRender]);

  const getMousePercent = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return canvasToPercent(
      (e.clientX - rect.left) * scaleX,
      (e.clientY - rect.top) * scaleY,
    );
  }, [canvasToPercent]);

  const hitTest = useCallback((r: PhotoRegion, px: number, py: number): boolean => {
    if (r.shape === "ellipse") {
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const dx = (px - cx) / (r.width / 2);
      const dy = (py - cy) / (r.height / 2);
      return dx * dx + dy * dy <= 1;
    }
    return px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height;
  }, []);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const pct = getMousePercent(e);
    if (!pct) return;

    const hit = [...regions].reverse().find(r => hitTest(r, pct.x, pct.y));
    if (hit) {
      setSelectedId(prev => prev === hit.id ? null : hit.id);
      return;
    }

    setSelectedId(null);
    drawStartRef.current = pct;
    setIsDrawing(true);
    setDrawState({ startX: pct.x, startY: pct.y, endX: pct.x, endY: pct.y });
  }, [regions, getMousePercent, hitTest]);

  // Window-level drag handlers: active only while isDrawing
  // This lets the user drag outside the canvas without losing the drag
  useEffect(() => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;

    const onMove = (e: MouseEvent) => {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const b = getImageBounds();
      if (!b) return;
      const cx = (e.clientX - rect.left) * scaleX;
      const cy = (e.clientY - rect.top) * scaleY;
      const px = Math.max(0, Math.min(100, (cx - b.x) / b.w * 100));
      const py = Math.max(0, Math.min(100, (cy - b.y) / b.h * 100));
      setDrawState(prev => prev ? { ...prev, endX: px, endY: py } : null);
    };

    const onUp = () => {
      const ds = drawStateRef.current;
      if (ds) {
        const w = Math.abs(ds.endX - ds.startX);
        const h = Math.abs(ds.endY - ds.startY);
        if (w >= 1 && h >= 1) {
          pushHistory(regionsRef.current);
          setRegions(prev => [...prev, {
            id: crypto.randomUUID(),
            type: drawMode,
            shape: drawShape,
            x: Math.min(ds.startX, ds.endX),
            y: Math.min(ds.startY, ds.endY),
            width: w,
            height: h,
            intensity,
          }]);
        }
      }
      setIsDrawing(false);
      drawStartRef.current = null;
      setDrawState(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDrawing, getImageBounds, drawMode, drawShape, intensity, pushHistory]);

  const handlePickOutputFolder = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false });
    if (dir && typeof dir === "string") setOutputFolder(dir);
  }, []);

  const handleLoadPhotos = useCallback(async () => {
    const files = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "tiff", "tif", "bmp", "webp"] }],
    });
    if (!files || (Array.isArray(files) && files.length === 0)) return;
    const paths: string[] = Array.isArray(files) ? files : [files];
    const items: PhotoItem[] = paths.map(p => ({
      filePath: p,
      fileName: p.split(/[/\\]/).pop() ?? p,
      status: "pending",
      willEdit: true,
      regions: [],
    }));
    setPhotos(items);
    setCurrentIndex(0);
    setRegions([]);
    setHistory([]);
    setSelectedId(null);
    setImgNatural(null);
    const firstDir = paths[0].replace(/[/\\][^/\\]+$/, "");
    setOutputFolder(firstDir + "\\blurred");
  }, []);

  const toggleWillEdit = useCallback((index: number) => {
    setPhotos(prev => prev.map((p, i) => i === index ? { ...p, willEdit: !p.willEdit } : p));
  }, []);

  const goTo = useCallback((index: number) => {
    const curIdx = currentIndexRef.current;
    const curRegions = regionsRef.current;
    const curPhotos = photosRef.current;

    // Save current regions into the photo we're leaving
    setPhotos(prev => prev.map((p, i) =>
      i === curIdx ? { ...p, regions: curRegions } : p
    ));

    // Clear canvas immediately to avoid showing stale regions on new photo
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    setCurrentIndex(index);
    // Restore the target photo's saved regions
    setRegions(curPhotos[index]?.regions ?? []);
    setHistory([]);
    setSelectedId(null);
    setImgNatural(null);
    setTimeout(() => {
      const item = listRef.current?.children[index] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }, 0);
  }, []);

  const handleSaveNext = useCallback(async () => {
    if (!currentPhoto || isSaving) return;
    setIsSaving(true);
    try {
      const sep = currentPhoto.filePath.includes("\\") ? "\\" : "/";
      const outputPath = outputFolder + sep + currentPhoto.fileName;
      await invoke("apply_photo_blur", {
        inputPath: currentPhoto.filePath,
        regions: regions.map(r => ({
          type: r.type,
          shape: r.shape,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          intensity: r.type === "blur" ? blurIntensity
            : r.type === "mosaic_face" ? mosaicFaceIntensity
            : mosaicBodyIntensity,
        })),
        outputPath,
      });
      setPhotos(prev => prev.map((p, i) => i === currentIndex ? { ...p, status: "done" } : p));
      setDrawMode("blur");
      if (currentIndex + 1 < photos.length) goTo(currentIndex + 1);
    } catch (err) {
      alert(`保存エラー: ${err}`);
    } finally {
      setIsSaving(false);
    }
  }, [currentPhoto, isSaving, outputFolder, regions, currentIndex, photos, goTo, blurIntensity, mosaicFaceIntensity, mosaicBodyIntensity]);

  const handleSkip = useCallback(() => {
    setPhotos(prev => prev.map((p, i) => i === currentIndex ? { ...p, status: "skipped" } : p));
    if (currentIndex + 1 < photos.length) goTo(currentIndex + 1);
  }, [currentIndex, goTo, photos]);

  const handleDeleteRegion = useCallback(() => {
    if (!selectedId) return;
    pushHistory(regions);
    setRegions(prev => prev.filter(r => r.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, regions, pushHistory]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleUndo();
        return;
      }

      if (e.key === "Enter") { e.preventDefault(); if (canSave) handleSaveNext(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); if (canSave) handleSaveNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); if (currentIndex > 0) goTo(currentIndex - 1); }
      else if (e.key === "s" || e.key === "S") handleSkip();
      else if (e.key === "Delete" || e.key === "Backspace") handleDeleteRegion();
      else if (e.key === "b" || e.key === "B") setDrawMode("blur");
      else if (e.key === "m" || e.key === "M") setDrawMode("mosaic_face");
      else if (e.key === "n" || e.key === "N") setDrawMode("mosaic_body");
      else if (e.key === "e" || e.key === "E") setDrawShape(s => s === "ellipse" ? "rect" : "ellipse");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSaveNext, handleSkip, handleDeleteRegion, handleUndo, goTo, currentIndex, canSave, setDrawMode]);

  return (
    <div className="flex flex-col h-full bg-zinc-900 text-white select-none">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-zinc-800 border-b border-zinc-700 flex-shrink-0">
        <button
          onClick={handleLoadPhotos}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
        >
          写真を選択
        </button>
        {photos.length > 0 && (
          <span className="text-sm text-zinc-400">
            全 {photos.length}枚 / 編集対象 {willEditCount}枚 / 保存済 {doneCount}枚
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-zinc-500">出力先:</span>
          <input
            type="text"
            value={outputFolder}
            onChange={e => setOutputFolder(e.target.value)}
            className="text-xs bg-zinc-700 rounded px-2 py-1 text-zinc-300 w-60"
            placeholder="出力フォルダ"
          />
          <button
            onClick={handlePickOutputFolder}
            className="px-2 py-1 bg-zinc-600 hover:bg-zinc-500 rounded text-xs text-zinc-300"
          >
            参照
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left: file list */}
        <div ref={listRef} className="w-52 flex-shrink-0 bg-zinc-800 border-r border-zinc-700 overflow-y-auto">
          {photos.length === 0 && (
            <div className="p-3 text-xs text-zinc-500">写真を選択してください</div>
          )}
          {photos.map((photo, i) => (
            <div
              key={photo.filePath}
              onClick={() => goTo(i)}
              className={`flex items-start gap-1.5 px-2 py-1.5 cursor-pointer text-xs border-b border-zinc-700/50 ${
                i === currentIndex ? "bg-blue-700/40 text-white" : "hover:bg-zinc-700/50 text-zinc-400"
              } ${!photo.willEdit ? "opacity-50" : ""}`}
            >
              {/* checkbox */}
              <input
                type="checkbox"
                checked={photo.willEdit}
                onClick={e => e.stopPropagation()}
                onChange={() => toggleWillEdit(i)}
                className="mt-0.5 flex-shrink-0 cursor-pointer"
              />
              {/* thumbnail */}
              <img
                src={convertFileSrc(photo.filePath)}
                alt=""
                className="w-10 h-8 object-cover flex-shrink-0 rounded"
                style={{ imageRendering: "auto" }}
              />
              {/* info */}
              <div className="flex-1 min-w-0">
                <div className="truncate leading-tight">{photo.fileName}</div>
                <div className={`text-[9px] mt-0.5 ${
                  photo.status === "done" ? "text-green-400"
                  : photo.status === "skipped" ? "text-zinc-500"
                  : photo.willEdit ? "text-zinc-500" : "text-zinc-600"
                }`}>
                  {photo.status === "done" ? "✓ 保存済"
                  : photo.status === "skipped" ? "スキップ"
                  : photo.willEdit ? "編集する" : "スキップ"}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Center: canvas */}
        <div ref={containerRef} className="flex-1 relative bg-black overflow-hidden">
          {currentPhoto && (
            <img
              ref={imgRef}
              key={currentPhoto.filePath}
              src={convertFileSrc(currentPhoto.filePath)}
              style={{ display: "none" }}
              onLoad={handleImageLoad}
              alt=""
            />
          )}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ cursor: "crosshair" }}
            onMouseDown={handleCanvasMouseDown}
          />
          {!currentPhoto && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm pointer-events-none">
              写真を選択してください
            </div>
          )}
        </div>

        {/* Right: controls */}
        <div className="w-44 flex-shrink-0 bg-zinc-800 border-l border-zinc-700 p-3 flex flex-col gap-3">
          {/* Draw mode */}
          <div>
            <div className="text-xs text-zinc-400 mb-1">エフェクト</div>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setDrawMode("blur")}
                className={`px-2 py-1.5 rounded text-xs font-medium ${
                  drawMode === "blur" ? "bg-blue-600 text-white" : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
                }`}
              >
                ぼかし（顔）(B)
              </button>
              <button
                onClick={() => setDrawMode("mosaic_face")}
                className={`px-2 py-1.5 rounded text-xs font-medium ${
                  drawMode === "mosaic_face" ? "bg-pink-600 text-white" : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
                }`}
              >
                モザイク（顔）(M)
              </button>
              <button
                onClick={() => setDrawMode("mosaic_body")}
                className={`px-2 py-1.5 rounded text-xs font-medium ${
                  drawMode === "mosaic_body" ? "bg-emerald-600 text-white" : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600"
                }`}
              >
                モザイク（局部）(N)
              </button>
            </div>
            {/* Save button */}
            <button
              onClick={handleSaveNext}
              disabled={!currentPhoto || isSaving || !canSave}
              className="mt-1 w-full px-2 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded text-xs font-bold"
              title={!canSave ? "チェックボックスをONにすると保存できます" : ""}
            >
              {isSaving ? "保存中..." : "保存して次へ"}
            </button>
          </div>

          {/* Shape */}
          <div>
            <div className="text-xs text-zinc-400 mb-1">形状 (E で切替)</div>
            <div className="flex gap-1">
              <button
                onClick={() => setDrawShape("ellipse")}
                className={`flex-1 px-1 py-1.5 rounded text-xs ${
                  drawShape === "ellipse" ? "bg-zinc-500 text-white" : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600"
                }`}
              >
                ○ 楕円
              </button>
              <button
                onClick={() => setDrawShape("rect")}
                className={`flex-1 px-1 py-1.5 rounded text-xs ${
                  drawShape === "rect" ? "bg-zinc-500 text-white" : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600"
                }`}
              >
                □ 四角
              </button>
            </div>
          </div>

          {/* Intensity — all three shown always */}
          <div className="flex flex-col gap-2">
            <div>
              <div className="text-xs text-zinc-400 mb-1">ぼかし強度: {blurIntensity}</div>
              <input
                type="range"
                min={3}
                max={50}
                value={blurIntensity}
                onChange={e => setBlurIntensity(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">モザイク（顔）強度: {mosaicFaceIntensity}</div>
              <input
                type="range"
                min={3}
                max={50}
                value={mosaicFaceIntensity}
                onChange={e => setMosaicFaceIntensity(Number(e.target.value))}
                className="w-full accent-pink-500"
              />
            </div>
            <div>
              <div className="text-xs text-zinc-400 mb-1">モザイク（局部）強度: {mosaicBodyIntensity}</div>
              <input
                type="range"
                min={3}
                max={50}
                value={mosaicBodyIntensity}
                onChange={e => setMosaicBodyIntensity(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
          </div>

          {/* Region list */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400">領域 ({regions.length})</span>
              <div className="flex gap-1">
                {history.length > 0 && (
                  <button onClick={handleUndo} className="text-[10px] text-zinc-500 hover:text-yellow-400">
                    取消
                  </button>
                )}
                {regions.length > 0 && (
                  <button
                    onClick={() => { pushHistory(regions); setRegions([]); setSelectedId(null); }}
                    className="text-[10px] text-zinc-500 hover:text-red-400"
                  >
                    全削除
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-0.5">
              {regions.map((r, i) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedId(prev => prev === r.id ? null : r.id)}
                  className={`flex items-center justify-between px-2 py-1 rounded cursor-pointer text-xs ${
                    r.id === selectedId
                      ? "bg-yellow-700/40 text-yellow-200"
                      : "bg-zinc-700/50 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  <span>
                    {i + 1}. {r.type === "blur" ? "ぼかし"
                      : r.type === "mosaic_face" ? "モザイク（顔）" : "モザイク（局部）"}
                    {" "}{r.shape === "ellipse" ? "○" : "□"}
                  </span>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      pushHistory(regions);
                      setRegions(prev => prev.filter(x => x.id !== r.id));
                      if (selectedId === r.id) setSelectedId(null);
                    }}
                    className="text-zinc-500 hover:text-red-400 ml-1"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Keyboard hints */}
          <div className="text-[10px] text-zinc-600 space-y-0.5 border-t border-zinc-700 pt-2">
            <div>Enter / → : 保存して次へ</div>
            <div>← : 前の写真</div>
            <div>S : スキップ</div>
            <div>Ctrl+Z : 取り消し</div>
            <div>Del : 選択領域削除</div>
            <div>B : ぼかし（顔）</div>
            <div>M : モザイク（顔）</div>
            <div>N : モザイク（局部）</div>
            <div>E : 形状切替</div>
          </div>
        </div>
      </div>

      {/* Bottom: navigation */}
      <div className="flex items-center justify-center gap-3 px-4 py-2 bg-zinc-800 border-t border-zinc-700 flex-shrink-0">
        <button
          onClick={() => { if (currentIndex > 0) goTo(currentIndex - 1); }}
          disabled={currentIndex === 0 || photos.length === 0}
          className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 rounded text-sm"
        >
          ← 前
        </button>
        <span className="text-sm text-zinc-400 min-w-[80px] text-center">
          {photos.length > 0 ? `${currentIndex + 1} / ${photos.length}` : "−"}
        </span>
        <button
          onClick={handleSkip}
          disabled={!currentPhoto}
          className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 rounded text-sm"
        >
          スキップ (S)
        </button>
      </div>
    </div>
  );
}
