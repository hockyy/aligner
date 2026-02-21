"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function snapToNearest(value: number, snaps: number[]): number {
  if (snaps.length === 0) return value;
  const sorted = [...snaps].sort((a, b) => a - b);
  let nearest = sorted[0];
  let minDist = Math.abs(value - nearest);
  for (const s of sorted) {
    const d = Math.abs(value - s);
    if (d < minDist) {
      minDist = d;
      nearest = s;
    }
  }
  return nearest;
}

type LayerRefs = {
  bodyTopY: number;
  faceBottomY: number;
  bodyBottomY: number;
  eyeLeftX: number;
  eyeLeftY: number;
  eyeRightX: number;
  eyeRightY: number;
};

type ImageLayer = {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: number;
  visible: boolean;
  refs?: LayerRefs;
};

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];

const RESIZE_HANDLES = ["n", "s", "e", "w", "nw", "ne", "sw", "se"] as const;

/** Convert image-space (0–1) coords to canvas coords. Uses object-contain letterboxing. */
function imageToCanvas(
  layer: { x: number; y: number; width: number; height: number; aspectRatio: number },
  u: number,
  v: number
): { x: number; y: number } {
  const { x, y, width, height, aspectRatio: R } = layer;
  const divRatio = width / height;
  if (divRatio > R) {
    const imgW = height * R;
    const left = (width - imgW) / 2;
    return { x: x + left + u * imgW, y: y + v * height };
  } else {
    const imgH = width / R;
    const top = (height - imgH) / 2;
    return { x: x + u * width, y: y + top + v * imgH };
  }
}

function getHandleStyle(handle: string) {
  const base = "absolute z-10 h-3 w-3 rounded-full border-2 border-amber-500 bg-zinc-900";
  const pos: React.CSSProperties = {};
  const inset = -6;
  if (handle.includes("n")) pos.top = inset;
  if (handle.includes("s")) pos.bottom = inset;
  if (handle.includes("e")) pos.right = inset;
  if (handle.includes("w")) pos.left = inset;
  if (handle === "n" || handle === "s") {
    pos.left = "50%";
    pos.transform = "translateX(-50%)";
  }
  if (handle === "e" || handle === "w") {
    pos.top = "50%";
    pos.transform = "translateY(-50%)";
  }
  const cursors: Record<string, string> = {
    n: "ns-resize",
    s: "ns-resize",
    e: "ew-resize",
    w: "ew-resize",
    nw: "nwse-resize",
    se: "nwse-resize",
    ne: "nesw-resize",
    sw: "nesw-resize",
  };
  pos.cursor = cursors[handle];
  return { className: base, style: pos };
}

const PRESET_BG_COLORS = [
  "#ffffff",
  "#000000",
  "#f3f4f6",
  "#1f2937",
  "#fef3c7",
  "#dbeafe",
];

export default function ImageAligner() {
  const [layers, setLayers] = useState<ImageLayer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [opacityUnselected, setOpacityUnselected] = useState(1);
  const [opacitySelected, setOpacitySelected] = useState(1);
  const [showBorders, setShowBorders] = useState(true);
  const [guideH1, setGuideH1] = useState(0.2);
  const [guideH2, setGuideH2] = useState(0.5);
  const [guideH3, setGuideH3] = useState(0.8);
  const [guideV1, setGuideV1] = useState(0.33);
  const [guideV2, setGuideV2] = useState(0.67);
  const [alignModalOpen, setAlignModalOpen] = useState(false);
  const [alignModalLayerIndex, setAlignModalLayerIndex] = useState(0);
  const [alignModalStep, setAlignModalStep] = useState(0);
  const [alignWarning, setAlignWarning] = useState<string | null>(null);
  const [snapToLayerCenters, setSnapToLayerCenters] = useState(true);
  const [showGuideLines, setShowGuideLines] = useState(true);
  const [guideLinesLocked, setGuideLinesLocked] = useState(false);
  const [draggingGuide, setDraggingGuide] = useState<"h1" | "h2" | "h3" | "v1" | "v2" | null>(null);
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const hasInitializedOpacity = useRef(false);
  const prevLayerCountRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({
    mouseX: 0,
    mouseY: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const alignModalCanvasRef = useRef<HTMLDivElement>(null);
  const [alignModalHover, setAlignModalHover] = useState<{ x: number; y: number } | null>(null);
  const historyRef = useRef<ImageLayer[][]>([]);
  const layersRef = useRef<ImageLayer[]>([]);
  const pendingUndoStateRef = useRef<ImageLayer[] | null>(null);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  const MAX_HISTORY = 50;

  const pushHistory = useCallback(() => {
    const state = layersRef.current.map((l) => ({
      ...l,
      visible: l.visible !== false,
      refs: l.refs ? { ...l.refs } : undefined,
    }));
    historyRef.current.push(state);
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    }
    setCanUndo(true);
  }, []);

  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const prev = historyRef.current.pop()!;
    setLayers(prev);
    setCanUndo(historyRef.current.length > 0);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo]);

  const n = layers.length;
  const oneOverN = n > 0 ? 1 / n : 1;

  useEffect(() => {
    if (n > 0 && !hasInitializedOpacity.current) {
      hasInitializedOpacity.current = true;
      setOpacityUnselected(oneOverN);
      setOpacitySelected(oneOverN);
    }
  }, [n, oneOverN]);

  useEffect(() => {
    if (n === 0) {
      prevLayerCountRef.current = 0;
      return;
    }
    if (n <= prevLayerCountRef.current) {
      prevLayerCountRef.current = n;
      return;
    }
    prevLayerCountRef.current = n;

    const runLayout = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;

      const targetHeight = rect.height * 0.8;

      setLayers((prev) =>
        prev.map((layer) => {
          const width = targetHeight * layer.aspectRatio;
          const x = (rect.width - width) / 2;
          const y = (rect.height - targetHeight) / 2;
          return { ...layer, x, y, width, height: targetHeight };
        })
      );
    };

    requestAnimationFrame(() => requestAnimationFrame(runLayout));
  }, [n]);

  const opacitySnapPoints = useMemo(() => {
    const base = [0, 0.1, 0.25, 1 / 3, 0.5, 0.75, 1];
    const withN = n > 0 ? [...base, 1 / n] : base;
    return [...new Set(withN)].sort((a, b) => a - b);
  }, [n]);

  const addImages = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files).filter((f) =>
      ACCEPTED_TYPES.includes(f.type)
    );
    if (fileArray.length === 0) return;

    pushHistory();

    const newLayers: ImageLayer[] = fileArray.map((file, i) => {
      const src = URL.createObjectURL(file);
      return {
        id: `${Date.now()}-${i}-${file.name}`,
        src,
        x: 100 + i * 40,
        y: 100 + i * 40,
        width: 300,
        height: 200,
        aspectRatio: 1,
        visible: true,
      };
    });

    setLayers((prev) => {
      const updated = [...prev, ...newLayers];
      newLayers.forEach((layer) => {
        const img = new Image();
        img.onload = () => {
          const aspectRatio = img.width / img.height;
          const canvas = canvasRef.current;
          const rect = canvas?.getBoundingClientRect();
          setLayers((l) =>
            l.map((ll) => {
              if (ll.id !== layer.id) return ll;
              const height = ll.height;
              const width = height * aspectRatio;
              const x = rect ? (rect.width - width) / 2 : ll.x;
              const y = rect ? (rect.height - height) / 2 : ll.y;
              return { ...ll, aspectRatio, width, height, x, y };
            })
          );
        };
        img.src = layer.src;
      });
      return updated;
    });
  }, [pushHistory]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.getData("layer-id")) return;
      if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
    },
    [addImages]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files?.length) addImages(files);
      e.target.value = "";
    },
    [addImages]
  );

  const handleMoveLayer = useCallback((index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index + 1 : index - 1;
    if (newIndex < 0 || newIndex >= layers.length) return;
    pushHistory();
    setLayers((prev) => {
      const next = [...prev];
      [next[index], next[newIndex]] = [next[newIndex], next[index]];
      return next;
    });
  }, [layers.length, pushHistory]);

  const handleLayerReorder = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    pushHistory();
    setLayers((prev) => {
      const next = [...prev];
      const [removed] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, removed);
      return next;
    });
  }, [pushHistory]);

  const handleLayerDragStart = useCallback((e: React.DragEvent, layerId: string) => {
    setDraggedLayerId(layerId);
    e.dataTransfer.setData("layer-id", layerId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(new Image(), 0, 0);
  }, []);

  const handleLayerDragEnd = useCallback(() => {
    setDraggedLayerId(null);
  }, []);

  const handleLayerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleLayerDrop = useCallback(
    (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      const layerId = e.dataTransfer.getData("layer-id");
      if (!layerId || layerId === layers[targetIndex]?.id) return;
      const fromIndex = layers.findIndex((l) => l.id === layerId);
      if (fromIndex === -1) return;
      handleLayerReorder(fromIndex, targetIndex);
      setDraggedLayerId(null);
    },
    [layers, handleLayerReorder]
  );

  const handleToggleLayerVisibility = useCallback(
    (layerId: string) => {
      pushHistory();
      setLayers((prev) =>
        prev.map((l) =>
          l.id === layerId ? { ...l, visible: l.visible === false } : l
        )
      );
    },
    [pushHistory]
  );

  const handleRemoveLayer = useCallback(() => {
    if (!selectedId) return;
    pushHistory();
    setLayers((prev) => prev.filter((l) => l.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, pushHistory]);

  const handleGuideMouseDown = useCallback(
    (e: React.MouseEvent, guide: "h1" | "h2" | "h3" | "v1" | "v2") => {
      e.stopPropagation();
      if (guideLinesLocked) return;
      setDraggingGuide(guide);
    },
    [guideLinesLocked]
  );

  const handleLayerMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-resize-handle]") || target.closest("[data-guide-line]")) return;
      e.stopPropagation();
      if (alignModalOpen) return;
      setSelectedId(id);
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      pendingUndoStateRef.current = layers.map((l) => ({ ...l }));
      dragOffset.current = {
        x: e.clientX - layer.x,
        y: e.clientY - layer.y,
      };
      setIsDragging(true);
    },
    [layers, alignModalOpen]
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, id: string, handle: string) => {
      e.stopPropagation();
      e.preventDefault();
      setSelectedId(id);
      const layer = layers.find((l) => l.id === id);
      if (!layer) return;
      pendingUndoStateRef.current = layers.map((l) => ({ ...l }));
      setIsResizing(true);
      setResizeHandle(handle);
      resizeStart.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        width: layer.width,
        height: layer.height,
        x: layer.x,
        y: layer.y,
      };
    },
    [layers]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (draggingGuide) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          let y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
          let x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          if (snapToLayerCenters && layers.length > 0) {
            const ySnaps = layers.map(
              (l) => (l.y + l.height / 2) / rect.height
            );
            const xSnaps = layers.map(
              (l) => (l.x + l.width / 2) / rect.width
            );
            const threshold = 0.02;
            if (draggingGuide === "h1" || draggingGuide === "h2" || draggingGuide === "h3") {
              const snapped = snapToNearest(y, ySnaps);
              if (Math.abs(y - snapped) < threshold) y = snapped;
            } else {
              const snapped = snapToNearest(x, xSnaps);
              if (Math.abs(x - snapped) < threshold) x = snapped;
            }
          }
          if (draggingGuide === "h1") setGuideH1(y);
          if (draggingGuide === "h2") setGuideH2(y);
          if (draggingGuide === "h3") setGuideH3(y);
          if (draggingGuide === "v1") setGuideV1(x);
          if (draggingGuide === "v2") setGuideV2(x);
        }
        return;
      }
      if (isResizing && selectedId && resizeHandle) {
        const start = resizeStart.current;
        const dx = e.clientX - start.mouseX;
        const dy = e.clientY - start.mouseY;
        const minSize = 50;

        setLayers((prev) =>
          prev.map((l) => {
            if (l.id !== selectedId) return l;
            let width = start.width;
            let height = start.height;
            let x = start.x;
            let y = start.y;

            if (resizeHandle.includes("e")) {
              width = Math.max(minSize, start.width + dx);
            }
            if (resizeHandle.includes("w")) {
              width = Math.max(minSize, start.width - dx);
              x = start.x + start.width - width;
            }
            if (resizeHandle.includes("s")) {
              height = Math.max(minSize, start.height + dy);
            }
            if (resizeHandle.includes("n")) {
              height = Math.max(minSize, start.height - dy);
              y = start.y + start.height - height;
            }

            // Maintain aspect ratio for corner resizes
            const layer = l;
            if (resizeHandle.length === 2) {
              const ratio = layer.aspectRatio;
              if (resizeHandle.includes("e") || resizeHandle.includes("w")) {
                height = width / ratio;
                if (resizeHandle.includes("n")) {
                  y = start.y + start.height - height;
                }
              } else {
                width = height * ratio;
                if (resizeHandle.includes("w")) {
                  x = start.x + start.width - width;
                }
              }
            }
            return { ...l, width, height, x, y };
          })
        );
        return;
      }

      if (isDragging && selectedId) {
        setLayers((prev) =>
          prev.map((l) =>
            l.id === selectedId
              ? {
                  ...l,
                  x: e.clientX - dragOffset.current.x,
                  y: e.clientY - dragOffset.current.y,
                }
              : l
          )
        );
      }
    },
    [isDragging, isResizing, selectedId, resizeHandle, draggingGuide, snapToLayerCenters, layers]
  );

  const handleMouseUp = useCallback(() => {
    if ((isDragging || isResizing) && pendingUndoStateRef.current) {
      historyRef.current.push(pendingUndoStateRef.current);
      if (historyRef.current.length > MAX_HISTORY) {
        historyRef.current.shift();
      }
      setCanUndo(true);
      pendingUndoStateRef.current = null;
    }
    setIsDragging(false);
    setIsResizing(false);
    setResizeHandle(null);
    setDraggingGuide(null);
  }, [isDragging, isResizing]);

  const handleCanvasClick = useCallback(() => {
    setSelectedId(null);
  }, []);

  const handleLayerPanelSelect = useCallback((id: string) => {
    setSelectedId(id);
    const layer = layers.find((l) => l.id === id);
    if (layer) {
      dragOffset.current = { x: 0, y: 0 };
    }
  }, [layers]);

  const handleAlignModalCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!alignModalOpen || !layers[alignModalLayerIndex]) return;
      e.stopPropagation();
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const localX = (e.clientX - rect.left) / rect.width;
      const localY = (e.clientY - rect.top) / rect.height;
      const clampedX = Math.max(0, Math.min(1, localX));
      const clampedY = Math.max(0, Math.min(1, localY));
      const id = layers[alignModalLayerIndex].id;

      const stepKeys: (keyof LayerRefs)[] = [
        "bodyTopY",
        "faceBottomY",
        "bodyBottomY",
        "eyeLeftX",
        "eyeRightX",
      ];
      const key = stepKeys[alignModalStep];

      setLayers((prev) =>
        prev.map((l) => {
          if (l.id !== id) return l;
          const refs = { ...(l.refs ?? defaultRefs()) };
          if (key === "bodyTopY") refs.bodyTopY = clampedY;
          if (key === "faceBottomY") refs.faceBottomY = clampedY;
          if (key === "bodyBottomY") refs.bodyBottomY = clampedY;
          if (key === "eyeLeftX") {
            refs.eyeLeftX = clampedX;
            refs.eyeLeftY = clampedY;
          }
          if (key === "eyeRightX") {
            refs.eyeRightX = clampedX;
            refs.eyeRightY = clampedY;
          }
          return { ...l, refs };
        })
      );
      if (alignModalStep < 4) {
        setAlignModalStep((s) => s + 1);
      } else {
        if (alignModalLayerIndex < layers.length - 1) {
          setAlignModalLayerIndex((i) => i + 1);
          setAlignModalStep(0);
        }
      }
    },
    [alignModalOpen, alignModalLayerIndex, alignModalStep, layers]
  );

  const handleAlignModalCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      setAlignModalHover({ x, y });
    },
    []
  );

  const handleAlignModalCanvasMouseLeave = useCallback(() => {
    setAlignModalHover(null);
  }, []);

  const handleAlignModalNext = useCallback(() => {
    if (alignModalStep < 4) {
      setAlignModalStep((s) => s + 1);
    } else if (alignModalLayerIndex < layers.length - 1) {
      setAlignModalLayerIndex((i) => i + 1);
      setAlignModalStep(0);
    }
  }, [alignModalStep, alignModalLayerIndex, layers.length]);

  const handleAlignModalPrev = useCallback(() => {
    if (alignModalStep > 0) {
      setAlignModalStep((s) => s - 1);
    } else if (alignModalLayerIndex > 0) {
      setAlignModalLayerIndex((i) => i - 1);
      setAlignModalStep(4);
    }
  }, [alignModalStep, alignModalLayerIndex]);

  const handleLayerClick = useCallback(
    (e: React.MouseEvent, id: string, _layer: ImageLayer) => {
      e.stopPropagation();
      if (alignModalOpen) return;
      setSelectedId(id);
    },
    [alignModalOpen]
  );

  function defaultRefs(): LayerRefs {
    return {
      bodyTopY: 0.2,
      faceBottomY: 0.5,
      bodyBottomY: 0.8,
      eyeLeftX: 0.35,
      eyeLeftY: 0.45,
      eyeRightX: 0.65,
      eyeRightY: 0.45,
    };
  }

  const runAutoAlign = useCallback(() => {
    if (layers.length < 2) return;
    setAlignWarning(null);

    const refLayer = layers[0];
    const refRefs = refLayer.refs ?? defaultRefs();

    const refEyeLeft = imageToCanvas(refLayer, refRefs.eyeLeftX, refRefs.eyeLeftY);
    const refEyeRight = imageToCanvas(refLayer, refRefs.eyeRightX, refRefs.eyeRightY);
    const refBodyTop = imageToCanvas(refLayer, 0.5, refRefs.bodyTopY);
    const refFaceBottom = imageToCanvas(refLayer, 0.5, refRefs.faceBottomY);
    const refBodyBottom = imageToCanvas(refLayer, 0.5, refRefs.bodyBottomY);

    const refEyeSpanX = refEyeRight.x - refEyeLeft.x;
    const refBodyFaceSpanY = refFaceBottom.y - refBodyTop.y;
    const refBodySpanY = refBodyBottom.y - refBodyTop.y;

    const refEyeCenterX = (refEyeLeft.x + refEyeRight.x) / 2;
    const refBodyFaceMidY = (refBodyTop.y + refFaceBottom.y) / 2;

    pushHistory();
    const warnings: string[] = [];
    setLayers((prev) =>
      prev.map((layer, idx) => {
        if (idx === 0) return layer;
        const refs = layer.refs ?? defaultRefs();
        const dxEye = refs.eyeRightX - refs.eyeLeftX;
        const dyFaceBody = refs.faceBottomY - refs.bodyTopY;
        const dyBody = refs.bodyBottomY - refs.bodyTopY;

        if (Math.abs(dxEye) < 0.01) return layer;
        if (Math.abs(dyFaceBody) < 0.01) return layer;

        const eyeCenterFrac = (refs.eyeLeftX + refs.eyeRightX) / 2;
        const bodyFaceMidFrac = (refs.bodyTopY + refs.faceBottomY) / 2;

        const newWidth = refEyeSpanX / dxEye;
        const newHeight = refBodyFaceSpanY / dyFaceBody;

        const newLayer = {
          ...layer,
          x: 0,
          y: 0,
          width: newWidth,
          height: newHeight,
          aspectRatio: layer.aspectRatio,
        };
        const divRatio = newWidth / newHeight;
        const R = layer.aspectRatio;

        let newX: number;
        let newY: number;
        if (divRatio > R) {
          const imgW = newHeight * R;
          const left = (newWidth - imgW) / 2;
          newX = refEyeCenterX - left - eyeCenterFrac * imgW;
          newY = refBodyFaceMidY - bodyFaceMidFrac * newHeight;
        } else {
          const imgH = newWidth / R;
          const top = (newHeight - imgH) / 2;
          newX = refEyeCenterX - eyeCenterFrac * newWidth;
          newY = refBodyFaceMidY - top - bodyFaceMidFrac * imgH;
        }

        if (Math.abs(dyBody) >= 0.01) {
          const resultLayer = { ...layer, x: newX, y: newY, width: newWidth, height: newHeight };
          const ourBodyBottom = imageToCanvas(resultLayer, 0.5, refs.bodyBottomY).y;
          const bodyBottomGap = Math.abs(ourBodyBottom - refBodyBottom.y);
          const refFaceToBody = (refRefs.faceBottomY - refRefs.bodyTopY) / (refRefs.bodyBottomY - refRefs.bodyTopY);
          const layerFaceToBody = dyFaceBody / dyBody;
          const positionMismatch = bodyBottomGap > Math.min(refBodySpanY, 50) * 0.2;
          const proportionMismatch = Math.abs(refFaceToBody - layerFaceToBody) > 0.15;
          if (positionMismatch || proportionMismatch) {
            warnings.push(`Layer ${idx + 1}: body bottom doesn't match reference`);
          }
        }

        return {
          ...layer,
          x: newX,
          y: newY,
          width: newWidth,
          height: newHeight,
        };
      })
    );
    if (warnings.length > 0) {
      setAlignWarning(warnings.join("; "));
    }
    setAlignModalOpen(false);
  }, [layers, pushHistory]);

  const handleAutoAlignClick = useCallback(() => {
    if (layers.length < 1) return;
    setAlignWarning(null);
    setAlignModalOpen(true);
    setAlignModalLayerIndex(0);
    setAlignModalStep(0);
  }, [layers.length]);

  const selectedLayerIndex = selectedId ? layers.findIndex((l) => l.id === selectedId) + 1 : 0;

  return (
    <div className="flex h-screen flex-col bg-zinc-900">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-zinc-700 bg-zinc-800 px-4 py-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-amber-400"
        >
          Select images
        </button>
        <div
          className="flex flex-1 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-zinc-600 bg-zinc-800/50 py-4 transition-colors hover:border-amber-500/60 hover:bg-zinc-800"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
        >
          <span className="text-sm text-zinc-400">
            Or drag and drop images here
          </span>
        </div>
        {layers.length > 0 && (
          <>
            <button
              onClick={undo}
              disabled={!canUndo}
              className="rounded-lg bg-zinc-600 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-500 disabled:opacity-40 disabled:hover:bg-zinc-600"
              title="Undo"
            >
              Undo
            </button>
            <span className="text-sm text-zinc-500">
              {layers.length} layer{layers.length !== 1 ? "s" : ""}
            </span>
            <div className="h-6 w-px bg-zinc-600" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Background</span>
              <div className="flex gap-1">
                {PRESET_BG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="h-6 w-6 rounded border-2 border-zinc-600 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor: backgroundColor === c ? "#f59e0b" : undefined,
                    }}
                    onClick={() => setBackgroundColor(c)}
                    title={c}
                  />
                ))}
              </div>
              <input
                type="color"
                value={backgroundColor}
                onChange={(e) => setBackgroundColor(e.target.value)}
                className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-zinc-500 whitespace-nowrap">
                  Unsel: {Math.round(opacityUnselected * 100)}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={opacityUnselected}
                  onChange={(e) => setOpacityUnselected(parseFloat(e.target.value))}
                  onMouseUp={(e) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    setOpacityUnselected(snapToNearest(v, opacitySnapPoints));
                  }}
                  onPointerUp={(e) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    setOpacityUnselected(snapToNearest(v, opacitySnapPoints));
                  }}
                  className="w-20 accent-amber-500"
                />
                {n > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpacityUnselected(snapToNearest(oneOverN, opacitySnapPoints))}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200"
                    title={`1/N (${Math.round(oneOverN * 100)}%)`}
                  >
                    1/N
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-zinc-500 whitespace-nowrap">
                  Sel: {Math.round(opacitySelected * 100)}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={opacitySelected}
                  onChange={(e) => setOpacitySelected(parseFloat(e.target.value))}
                  onMouseUp={(e) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    setOpacitySelected(snapToNearest(v, opacitySnapPoints));
                  }}
                  onPointerUp={(e) => {
                    const v = parseFloat((e.target as HTMLInputElement).value);
                    setOpacitySelected(snapToNearest(v, opacitySnapPoints));
                  }}
                  className="w-20 accent-amber-500"
                />
                {n > 0 && (
                  <button
                    type="button"
                    onClick={() => setOpacitySelected(snapToNearest(oneOverN, opacitySnapPoints))}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200"
                    title={`1/N (${Math.round(oneOverN * 100)}%)`}
                  >
                    1/N
                  </button>
                )}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={showBorders}
                onChange={(e) => setShowBorders(e.target.checked)}
                className="h-4 w-4 accent-amber-500"
              />
              <span className="text-xs text-zinc-400">Show borders</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={showGuideLines}
                onChange={(e) => setShowGuideLines(e.target.checked)}
                className="h-4 w-4 accent-amber-500"
              />
              <span className="text-xs text-zinc-400">Guide lines</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={guideLinesLocked}
                onChange={(e) => setGuideLinesLocked(e.target.checked)}
                className="h-4 w-4 accent-amber-500"
              />
              <span className="text-xs text-zinc-400">Lock guides</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={snapToLayerCenters}
                onChange={(e) => setSnapToLayerCenters(e.target.checked)}
                className="h-4 w-4 accent-amber-500"
              />
              <span className="text-xs text-zinc-400">Snap to centers</span>
            </label>
            <button
              type="button"
              onClick={handleAutoAlignClick}
              disabled={layers.length < 1}
              className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              title="Set reference points then align layers to first"
            >
              Auto align
            </button>
            {alignWarning && (
              <div className="rounded bg-amber-900/80 px-2 py-1 text-xs text-amber-200">
                {alignWarning}
              </div>
            )}
            {selectedId && (
              <>
                <span className="text-sm text-amber-400">
                  Layer {selectedLayerIndex} of {n}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleMoveLayer(selectedLayerIndex - 1, "up")}
                    disabled={selectedLayerIndex <= 1}
                    className="rounded-lg bg-zinc-600 px-2 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-500 disabled:opacity-40"
                    title="Move layer up"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => handleMoveLayer(selectedLayerIndex - 1, "down")}
                    disabled={selectedLayerIndex >= n}
                    className="rounded-lg bg-zinc-600 px-2 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-500 disabled:opacity-40"
                    title="Move layer down"
                  >
                    ↓
                  </button>
                </div>
                <button
                  onClick={handleRemoveLayer}
                  className="rounded-lg bg-red-600/80 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
                >
                  Remove layer
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Main content: layer panel + canvas */}
      <div className="flex flex-1 min-h-0">
        {/* Layer panel */}
        {layers.length > 0 && (
          <div className="flex w-44 shrink-0 flex-col gap-2 border-r border-zinc-700 bg-zinc-800/50 p-3">
            <span className="text-xs font-medium text-zinc-400">Layers</span>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {[...layers].reverse().map((layer, revIdx) => {
                const i = layers.length - 1 - revIdx;
                return (
                  <div
                    key={layer.id}
                    draggable
                    onDragStart={(e) => handleLayerDragStart(e, layer.id)}
                    onDragEnd={handleLayerDragEnd}
                    onDragOver={handleLayerDragOver}
                    onDrop={(e) => handleLayerDrop(e, i)}
                    className={`flex cursor-grab items-center gap-1 rounded-lg border-2 p-1 transition-colors active:cursor-grabbing ${
                      selectedId === layer.id
                        ? "border-amber-500 bg-zinc-700"
                        : draggedLayerId === layer.id
                          ? "border-cyan-500/50 opacity-60"
                          : "border-zinc-600 bg-zinc-800"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleLayerPanelSelect(layer.id)}
                      className="flex flex-1 min-w-0 items-center gap-2 text-left"
                    >
                      <div className={`relative h-10 w-10 shrink-0 overflow-hidden rounded bg-zinc-700 ${layer.visible === false ? "opacity-40" : ""}`}>
                        <img
                          src={layer.src}
                          alt=""
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                        {layer.visible === false && (
                          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/60">
                            <svg className="h-5 w-5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <span className="truncate text-xs text-zinc-300">
                        {i + 1}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleLayerVisibility(layer.id);
                        }}
                        className="rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200"
                        title={layer.visible === false ? "Show layer" : "Hide layer"}
                      >
                        {layer.visible === false ? (
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                          </svg>
                        ) : (
                          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                      <div className="flex flex-col">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMoveLayer(i, "up");
                        }}
                        disabled={i === layers.length - 1}
                        className="rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Bring forward"
                      >
                        <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 15l-6-6-6 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMoveLayer(i, "down");
                        }}
                        disabled={i === 0}
                        className="rounded p-0.5 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
                        title="Send backward"
                      >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="relative flex-1 overflow-hidden"
        style={{ backgroundColor }}
        onClick={handleCanvasClick}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {layers.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-zinc-500">Import images to get started</p>
          </div>
        ) : (
          layers.map((layer, idx) => {
            const isAlignTarget = alignModalOpen && idx === alignModalLayerIndex;
            return (
            <div
              key={layer.id}
              className="absolute cursor-move select-none"
              style={{
                left: layer.x,
                top: layer.y,
                width: layer.width,
                height: layer.height,
                zIndex: isAlignTarget
                  ? 250
                  : selectedId === layer.id
                    ? 100
                    : layers.indexOf(layer),
                visibility: layer.visible === false ? "hidden" : "visible",
                pointerEvents: layer.visible === false ? "none" : "auto",
              }}
              onClick={(e) => handleLayerClick(e, layer.id, layer)}
              onMouseDown={(e) => handleLayerMouseDown(e, layer.id)}
            >
              <img
                src={layer.src}
                alt="Layer"
                draggable={false}
                className="pointer-events-none h-full w-full object-contain"
                style={{
                  opacity: isAlignTarget ? 1 : selectedId === layer.id ? opacitySelected : opacityUnselected,
                  border: isAlignTarget
                    ? "3px solid rgb(34 211 238)"
                    : showBorders
                      ? selectedId === layer.id
                        ? "2px solid rgb(245 158 11)"
                        : "1px solid rgb(82 82 91)"
                      : "none",
                  borderRadius: 4,
                }}
              />
              {selectedId === layer.id &&
                RESIZE_HANDLES.map((handle) => {
                  const { className, style } = getHandleStyle(handle);
                  return (
                    <div
                      key={handle}
                      data-resize-handle
                      className={className}
                      style={style}
                      onMouseDown={(e) =>
                        handleResizeMouseDown(e, layer.id, handle)
                      }
                    />
                  );
                })}
            </div>
            );
          })
        )}
        {/* Guide lines hint */}
        {layers.length > 0 && showGuideLines && !alignModalOpen && (
          <div
            className="absolute bottom-2 left-2 z-[150] max-w-[220px] rounded bg-zinc-800/90 px-2 py-1.5 text-xs text-zinc-400"
            title="Click Auto align to set ref points per layer, then apply"
          >
            Auto align: set 5 ref points per layer (first = reference)
          </div>
        )}
        {/* Layer center snap lines (when snap to centers is on) */}
        {layers.length > 0 && snapToLayerCenters &&
          layers.map((layer) => (
            <div key={`center-${layer.id}`} className="pointer-events-none absolute inset-0 z-[180]">
              <div
                className="absolute left-0 right-0 h-0 border-t border-dashed border-amber-500/40"
                style={{ top: layer.y + layer.height / 2 }}
              />
              <div
                className="absolute top-0 bottom-0 w-0 border-l border-dashed border-amber-500/40"
                style={{ left: layer.x + layer.width / 2 }}
              />
            </div>
          ))}
        {/* Guide lines */}
        {layers.length > 0 && showGuideLines && (
          <>
            <div
              className={`absolute left-0 right-0 z-[200] h-3 -translate-y-1/2 py-1 ${guideLinesLocked ? "cursor-default" : "cursor-ns-resize"}`}
              style={{ top: `${guideH1 * 100}%` }}
              data-guide-line
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => handleGuideMouseDown(e, "h1")}
            >
              <div className="h-px w-full bg-cyan-500/90" />
            </div>
            <div
              className={`absolute left-0 right-0 z-[200] h-3 -translate-y-1/2 py-1 ${guideLinesLocked ? "cursor-default" : "cursor-ns-resize"}`}
              style={{ top: `${guideH2 * 100}%` }}
              data-guide-line
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => handleGuideMouseDown(e, "h2")}
            >
              <div className="h-px w-full bg-cyan-500/90" />
            </div>
            <div
              className={`absolute left-0 right-0 z-[200] h-3 -translate-y-1/2 py-1 ${guideLinesLocked ? "cursor-default" : "cursor-ns-resize"}`}
              style={{ top: `${guideH3 * 100}%` }}
              data-guide-line
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => handleGuideMouseDown(e, "h3")}
            >
              <div className="h-px w-full bg-cyan-500/90" />
            </div>
            <div
              className={`absolute top-0 bottom-0 z-[200] w-3 -translate-x-1/2 px-1 ${guideLinesLocked ? "cursor-default" : "cursor-ew-resize"}`}
              style={{ left: `${guideV1 * 100}%` }}
              data-guide-line
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => handleGuideMouseDown(e, "v1")}
            >
              <div className="h-full w-px bg-cyan-500/90" />
            </div>
            <div
              className={`absolute top-0 bottom-0 z-[200] w-3 -translate-x-1/2 px-1 ${guideLinesLocked ? "cursor-default" : "cursor-ew-resize"}`}
              style={{ left: `${guideV2 * 100}%` }}
              data-guide-line
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => handleGuideMouseDown(e, "v2")}
            >
              <div className="h-full w-px bg-cyan-500/90" />
            </div>
          </>
        )}
      </div>
      </div>

      {/* Auto align modal - canvas UI with single image + guide lines */}
      {alignModalOpen && layers.length > 0 && (() => {
        const layer = layers[alignModalLayerIndex];
        if (!layer) return null;
        const refs = layer.refs ?? defaultRefs();
        const stepLabels = ["Body top", "Face bottom", "Body bottom", "Eye left (tip)", "Eye right (tip)"];
        const isYStep = alignModalStep <= 2;
        const isEyeStep = alignModalStep >= 3;
        const lineY = isYStep ? (alignModalHover?.y ?? (alignModalStep === 0 ? refs.bodyTopY : alignModalStep === 1 ? refs.faceBottomY : refs.bodyBottomY)) : (isEyeStep ? (alignModalHover?.y ?? (alignModalStep === 3 ? refs.eyeLeftY : refs.eyeRightY)) : 0.5);
        const lineX = isEyeStep ? (alignModalHover?.x ?? (alignModalStep === 3 ? refs.eyeLeftX : refs.eyeRightX)) : (alignModalHover?.x ?? 0.5);

        return (
          <>
            <div className="fixed inset-0 z-[290] bg-black/80" onClick={() => setAlignModalOpen(false)} />
            <div className="fixed inset-0 z-[300] flex flex-col items-center justify-center p-6 pointer-events-none">
              <div className="pointer-events-auto flex w-full max-w-7xl flex-col items-center">
              <div className="mb-4 flex w-full items-center justify-between">
                <h3 className="text-lg font-medium text-white">
                  Layer {alignModalLayerIndex + 1} of {layers.length} — {stepLabels[alignModalStep]}
                </h3>
                <button
                  type="button"
                  onClick={() => setAlignModalOpen(false)}
                  className="rounded p-2 text-zinc-400 hover:bg-zinc-700 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <div
                ref={alignModalCanvasRef}
                className="relative flex min-h-[500px] max-h-[90vh] w-full max-w-7xl flex-1 min-w-0 items-center justify-center overflow-auto rounded-lg border border-zinc-600 bg-zinc-900"
              >
                <div
                  className="relative mx-auto my-auto shrink-0"
                  style={{
                    aspectRatio: layer.aspectRatio,
                    maxHeight: "100%",
                    maxWidth: "100%",
                    width: layer.aspectRatio >= 1 ? "100%" : "auto",
                    height: layer.aspectRatio >= 1 ? "auto" : "100%",
                  }}
                >
                  <img
                    src={layer.src}
                    alt=""
                    className="absolute inset-0 h-full w-full object-contain"
                    draggable={false}
                  />
                  <div
                    className="absolute inset-0 cursor-crosshair"
                    onClick={handleAlignModalCanvasClick}
                    onMouseMove={handleAlignModalCanvasMouseMove}
                    onMouseLeave={handleAlignModalCanvasMouseLeave}
                  >
                    {/* Persistent XY indicator lines (all refs when set) */}
                    <div className="pointer-events-none absolute inset-0">
                      <div className="absolute left-0 right-0 h-px bg-cyan-400/50" style={{ top: `${refs.bodyTopY * 100}%` }} title="Body top" />
                      <div className="absolute left-0 right-0 h-px bg-cyan-400/50" style={{ top: `${refs.faceBottomY * 100}%` }} title="Face bottom" />
                      <div className="absolute left-0 right-0 h-px bg-cyan-400/50" style={{ top: `${refs.bodyBottomY * 100}%` }} title="Body bottom" />
                      <div className="absolute top-0 bottom-0 w-px bg-cyan-400/50" style={{ left: `${refs.eyeLeftX * 100}%` }} title="Eye left" />
                      <div className="absolute top-0 bottom-0 w-px bg-cyan-400/50" style={{ left: `${refs.eyeRightX * 100}%` }} title="Eye right" />
                    </div>
                    {/* Current step crosshair (brighter) */}
                    {(isYStep || isEyeStep) && (
                      <div
                        className="pointer-events-none absolute left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_4px_cyan]"
                        style={{ top: `${lineY * 100}%` }}
                      />
                    )}
                    {isEyeStep && (
                      <div
                        className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-cyan-400 shadow-[0_0_4px_cyan]"
                        style={{ left: `${lineX * 100}%` }}
                      />
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex w-full max-w-7xl justify-between gap-2">
                <button
                  type="button"
                  onClick={handleAlignModalPrev}
                  disabled={alignModalLayerIndex === 0 && alignModalStep === 0}
                  className="rounded-lg bg-zinc-600 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-500 disabled:opacity-40"
                >
                  Prev
                </button>
                {alignModalLayerIndex === layers.length - 1 && alignModalStep === 4 ? (
                  <button
                    type="button"
                    onClick={runAutoAlign}
                    disabled={layers.length < 2}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    Apply alignment
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleAlignModalNext}
                    className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
                  >
                    Next
                </button>
              )}
              </div>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}
