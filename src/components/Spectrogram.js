import React, { useEffect, useRef, useState } from "react";
const GRID_COLOR = "rgba(255, 255, 255, 0.12)";
const PANEL_BORDER = "rgba(255, 255, 255, 0.14)";
const PANEL_FILL = "rgba(255, 255, 255, 0.03)";
const LABEL_COLOR = "rgba(255, 255, 255, 0.78)";
const MUTED_LABEL_COLOR = "rgba(255, 255, 255, 0.54)";
const PLAYHEAD_COLOR = "rgba(255, 255, 255, 0.82)";
const MIN_VIEW_FRAMES = 64;
const MIN_VIEW_ROWS = 12;
const SPECTRUM_DOMAIN_MAX = 900;
const SPECTRUM_PEAK_FILL = SPECTRUM_DOMAIN_MAX * 0.72;
const SPECTRUM_GAMMA = 0.92;
const SPECTRUM_NOISE_FLOOR_QUANTILE = 0.5;
const SPECTRUM_SMOOTH_WEIGHTS = [1, 2, 3, 2, 1];
const WAVEFORM_SMOOTH_WEIGHTS = [1, 2, 3, 2, 1];
const WAVEFORM_EDGE_HIT_PIXELS = 10;
const MAX_WAVEFORM_WINDOW_SECONDS = 4;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const createTicks = (min, max, count) => {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [];
  }

  const span = max - min;
  const roughStep = span / Math.max(count, 1);
  const power = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / power;
  const step =
    normalized >= 5 ? 5 * power : normalized >= 2 ? 2 * power : power;
  const start = Math.ceil(min / step) * step;
  const ticks = [];

  for (let value = start; value <= max + step * 0.5; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }

  return ticks;
};

const formatNumber = (value) => {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(0);
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
};

const getPixelRatio = () =>
  typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

const getLayout = (width, height) => {
  const top = 20;
  const left = 64;
  const gap = 26;
  const right = 64;
  const bottom = 48;
  const spectrumWidth = 56;
  const waveformHeight = clamp(height * 0.14, 46, 70);

  const spectrogramWidth = Math.max(
    120,
    width - left - right - gap - spectrumWidth,
  );
  const spectrogramHeight = Math.max(
    120,
    height - top - bottom - gap - waveformHeight,
  );

  return {
    root: { x: 0, y: 0, width, height },
    spectrogram: {
      x: left,
      y: top,
      width: spectrogramWidth,
      height: spectrogramHeight,
    },
    spectrum: {
      x: left + spectrogramWidth + gap,
      y: top,
      width: spectrumWidth,
      height: spectrogramHeight,
    },
    waveform: {
      x: left,
      y: top + spectrogramHeight + gap,
      width: spectrogramWidth,
      height: waveformHeight,
    },
  };
};

const toDeviceRect = (rect, dpr, canvasHeight) => ({
  x: Math.round(rect.x * dpr),
  y: Math.round((canvasHeight - rect.y - rect.height) * dpr),
  width: Math.max(1, Math.round(rect.width * dpr)),
  height: Math.max(1, Math.round(rect.height * dpr)),
});

const isPointInside = (rect, x, y) =>
  x >= rect.x &&
  x <= rect.x + rect.width &&
  y >= rect.y &&
  y <= rect.y + rect.height;

const flattenSpectrogram = (data) => {
  const width = data.length || 0;
  const height = width > 0 && Array.isArray(data[0]) ? data[0].length : 0;
  const pixels = new Uint8Array(width * height);

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      pixels[row * width + column] = data[column]?.[row] ?? 0;
    }
  }

  return { width, height, pixels };
};

const buildWaveformPoints = (waveData, totalFrames) => {
  if (!waveData || waveData.length === 0) {
    return { points: new Float32Array(0), amplitude: 1 };
  }

  const points = new Float32Array(waveData.length * 2);
  const smoothedValues = new Array(waveData.length).fill(0);
  const center = Math.floor(WAVEFORM_SMOOTH_WEIGHTS.length / 2);
  const maxFrame = Math.max(totalFrames, 1);
  const xDenominator = Math.max(waveData.length - 1, 1);
  let amplitude = 0;

  for (let index = 0; index < waveData.length; index += 1) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (
      let weightIndex = 0;
      weightIndex < WAVEFORM_SMOOTH_WEIGHTS.length;
      weightIndex += 1
    ) {
      const sourceIndex = clamp(
        index + weightIndex - center,
        0,
        waveData.length - 1,
      );
      const weight = WAVEFORM_SMOOTH_WEIGHTS[weightIndex];
      weightedSum += (Number(waveData[sourceIndex]) || 0) * weight;
      weightTotal += weight;
    }
    const value = weightTotal > 0 ? weightedSum / weightTotal : 0;
    smoothedValues[index] = value;
    amplitude = Math.max(amplitude, Math.abs(value));
  }

  const normalizedAmplitude = amplitude > 0 ? amplitude : 1;
  for (let index = 0; index < waveData.length; index += 1) {
    points[index * 2] = (index / xDenominator) * maxFrame;
    points[index * 2 + 1] =
      (smoothedValues[index] / normalizedAmplitude) * 0.88;
  }

  return { points, amplitude: 1 };
};

const buildSpectrumPoints = (data, columnIndex) => {
  const column = data[columnIndex];
  if (!column || column.length === 0) {
    return new Float32Array(0);
  }

  const smoothedValues = new Array(column.length).fill(0);
  const center = Math.floor(SPECTRUM_SMOOTH_WEIGHTS.length / 2);

  for (let index = 0; index < column.length; index += 1) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (
      let weightIndex = 0;
      weightIndex < SPECTRUM_SMOOTH_WEIGHTS.length;
      weightIndex += 1
    ) {
      const sourceIndex = clamp(
        index + weightIndex - center,
        0,
        column.length - 1,
      );
      const weight = SPECTRUM_SMOOTH_WEIGHTS[weightIndex];
      weightedSum += (Number(column[sourceIndex]) || 0) * weight;
      weightTotal += weight;
    }
    smoothedValues[index] = weightTotal > 0 ? weightedSum / weightTotal : 0;
  }

  const sortedValues = smoothedValues
    .slice()
    .sort((left, right) => left - right);
  const noiseFloorIndex = clamp(
    Math.floor((sortedValues.length - 1) * SPECTRUM_NOISE_FLOOR_QUANTILE),
    0,
    sortedValues.length - 1,
  );
  const noiseFloor = sortedValues[noiseFloorIndex] || 0;

  let maxValue = 0;
  const processedValues = new Array(column.length).fill(0);
  for (let index = 0; index < column.length; index += 1) {
    const value = Math.max(smoothedValues[index] - noiseFloor, 0);
    processedValues[index] = value;
    if (value > maxValue) {
      maxValue = value;
    }
  }

  const points = new Float32Array(column.length * 2);
  for (let index = 0; index < column.length; index += 1) {
    const normalizedValue =
      maxValue > 0
        ? (processedValues[index] / maxValue) ** SPECTRUM_GAMMA *
          SPECTRUM_PEAK_FILL
        : 0;
    points[index * 2] = normalizedValue;
    points[index * 2 + 1] = index;
  }
  return points;
};

const createShader = (gl, type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
};

const createProgram = (gl, vertexSource, fragmentSource) => {
  const program = gl.createProgram();
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Program linking failed.";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
};

const createTexture = (gl) => {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
};

const updateTexture = (gl, texture, width, height, pixels) => {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    width,
    height,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
};

const updateBuffer = (gl, buffer, points, usage = gl.STATIC_DRAW) => {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, points, usage);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
};

const destroyGlState = (glState) => {
  if (!glState) {
    return;
  }

  const { gl } = glState;
  if (!gl) {
    return;
  }

  gl.deleteBuffer(glState.quadBuffer);
  gl.deleteBuffer(glState.waveformBuffer);
  gl.deleteBuffer(glState.spectrumBuffer);
  gl.deleteTexture(glState.spectrogramTexture);
  gl.deleteProgram(glState.spectrogramProgram);
  gl.deleteProgram(glState.lineProgram);
};

const SPECTROGRAM_VERTEX_SOURCE = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const SPECTROGRAM_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D uTexture;
uniform float uLoadedStart;
uniform float uViewStart;
uniform float uViewSpan;
uniform float uViewRowStart;
uniform float uViewRowSpan;
uniform vec2 uTextureSize;

in vec2 vUv;
out vec4 outColor;

vec3 palette(float t) {
  vec3 c0 = vec3(0.0, 0.0, 0.0);
  vec3 c1 = vec3(0.18, 0.03, 0.24);
  vec3 c2 = vec3(0.30, 0.05, 0.46);
  vec3 c3 = vec3(0.82, 0.14, 0.52);
  vec3 c4 = vec3(1.0, 1.0, 1.0);
  vec3 c5 = vec3(1.0, 0.84, 0.16);

  if (t < 0.2) {
    return mix(c0, c1, t / 0.2);
  }
  if (t < 0.4) {
    return mix(c1, c2, (t - 0.2) / 0.2);
  }
  if (t < 0.6) {
    return mix(c2, c3, (t - 0.4) / 0.2);
  }
  if (t < 0.8) {
    return mix(c3, c4, (t - 0.6) / 0.2);
  }
  return mix(c4, c5, (t - 0.8) / 0.2);
}

void main() {
  if (uTextureSize.x <= 0.5 || uTextureSize.y <= 0.5) {
    outColor = vec4(0.07, 0.07, 0.09, 1.0);
    return;
  }

  float viewX = clamp(vUv.x, 0.0, 1.0);
  float viewY = clamp(vUv.y, 0.0, 1.0);
  float viewColumnSpan = max(uViewSpan - 1.0, 0.0);
  float viewRowSpan = max(uViewRowSpan - 1.0, 0.0);
  float localColumn = (uViewStart - uLoadedStart) + viewX * viewColumnSpan;
  if (localColumn < 0.0 || localColumn > uTextureSize.x - 1.0) {
    outColor = vec4(0.07, 0.07, 0.09, 1.0);
    return;
  }

  float localRow = uViewRowStart + viewY * viewRowSpan;
  float texU = (localColumn + 0.5) / uTextureSize.x;
  float texV = (localRow + 0.5) / uTextureSize.y;
  float intensity = texture(uTexture, vec2(texU, texV)).r;
  outColor = vec4(palette(intensity), 1.0);
}
`;

const LINE_VERTEX_SOURCE = `#version 300 es
precision highp float;

in vec2 aPoint;
uniform vec2 uDomainX;
uniform vec2 uDomainY;

void main() {
  float xSpan = max(uDomainX.y - uDomainX.x, 0.0001);
  float ySpan = max(uDomainY.y - uDomainY.x, 0.0001);
  float x = ((aPoint.x - uDomainX.x) / xSpan) * 2.0 - 1.0;
  float y = ((aPoint.y - uDomainY.x) / ySpan) * 2.0 - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const LINE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform vec4 uColor;
out vec4 outColor;

void main() {
  outColor = uColor;
}
`;

const drawPanelFrame = (ctx, rect) => {
  ctx.fillStyle = PANEL_FILL;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
};

const drawGrid = (ctx, rect, ticks, axis) => {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  ticks.forEach((tick) => {
    if (axis === "x") {
      ctx.beginPath();
      ctx.moveTo(tick, rect.y);
      ctx.lineTo(tick, rect.y + rect.height);
      ctx.stroke();
      return;
    }

    ctx.beginPath();
    ctx.moveTo(rect.x, tick);
    ctx.lineTo(rect.x + rect.width, tick);
    ctx.stroke();
  });

  ctx.restore();
};

const drawTickLabels = ({
  ctx,
  values,
  formatter,
  axis,
  rect,
  side = "left",
  gap = 10,
  textColor = LABEL_COLOR,
}) => {
  ctx.save();
  ctx.fillStyle = textColor;
  ctx.font = "12px sans-serif";
  ctx.textBaseline = axis === "x" ? "top" : "middle";
  ctx.textAlign = axis === "x" ? "center" : side === "right" ? "left" : "right";

  values.forEach(({ value, position }) => {
    if (axis === "x") {
      ctx.fillText(formatter(value), position, rect.y + rect.height + 8);
      return;
    }
    const labelX = side === "right" ? rect.x + rect.width + gap : rect.x - gap;
    ctx.fillText(formatter(value), labelX, position);
  });

  ctx.restore();
};

const drawLabel = (ctx, text, x, y, options = {}) => {
  ctx.save();
  ctx.fillStyle = options.color || LABEL_COLOR;
  ctx.font = options.font || "12px sans-serif";
  ctx.textAlign = options.align || "left";
  ctx.textBaseline = options.baseline || "alphabetic";
  ctx.fillText(text, x, y);
  ctx.restore();
};

const Spectrogram = ({
  data,
  waveData,
  id,
  duration,
  samplerate,
  sampleCount,
  offset,
  visibleStart,
  visibleEnd,
  playbackCursor,
  onVisibleWindowChange,
  maxF,
  maxS,
}) => {
  const initialRowEnd = Math.max((data[0]?.length || 1) - 1, 1);
  const containerRef = useRef(null);
  const glCanvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const glStateRef = useRef(null);
  const viewRef = useRef({
    start: offset,
    end: offset + data.length,
    rowStart: 0,
    rowEnd: initialRowEnd,
  });
  const rafRef = useRef(null);
  const playbackRafRef = useRef(null);
  const scheduleDrawRef = useRef(null);
  const visibleWindowChangeRef = useRef(null);
  const hoverRef = useRef({
    active: false,
    frameIndex: offset,
    rowIndex: 0,
  });
  const waveformAmplitudeRef = useRef(1);
  const interactionRef = useRef({
    dragMode: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    viewStart: 0,
    viewEnd: 0,
    viewRowStart: 0,
    viewRowEnd: initialRowEnd,
    waveformSelection: null,
    spectrogramSelection: null,
  });
  const propsRef = useRef({
    data,
    waveData,
    duration,
    samplerate,
    sampleCount,
    offset,
    visibleStart,
    visibleEnd,
    playbackCursor,
    maxF,
    maxS,
  });
  const [webglError, setWebglError] = useState("");
  const cursorRef = useRef("");

  propsRef.current = {
    data,
    waveData,
    duration,
    samplerate,
    sampleCount,
    offset,
    visibleStart,
    visibleEnd,
    playbackCursor,
    maxF,
    maxS,
  };

  const getTotalFrames = () => {
    const current = propsRef.current;
    if (Number.isFinite(current.sampleCount) && current.sampleCount > 0) {
      return Math.max(Math.ceil(current.sampleCount / 128), 1);
    }

    if (
      Number.isFinite(current.duration) &&
      current.duration > 0 &&
      Number.isFinite(current.samplerate) &&
      current.samplerate > 0
    ) {
      return Math.max(
        Math.ceil((current.duration * current.samplerate) / 128),
        1,
      );
    }

    return Math.max(current.offset + current.data.length, 1);
  };

  const frameToSeconds = (frameIndex) => {
    const current = propsRef.current;
    if (Number.isFinite(current.samplerate) && current.samplerate > 0) {
      return (frameIndex * 128) / current.samplerate;
    }
    return current.maxS > 0 ? frameIndex / current.maxS : frameIndex;
  };

  const rowToFrequency = (rowIndex) => {
    const current = propsRef.current;
    return current.maxF > 0 ? rowIndex / current.maxF : rowIndex;
  };

  const getMaxWaveformWindowFrames = () => {
    const current = propsRef.current;
    const totalFrames = Math.max(getTotalFrames(), 1);
    if (!Number.isFinite(current.samplerate) || current.samplerate <= 0) {
      return totalFrames;
    }

    return Math.min(
      totalFrames,
      Math.max(
        1,
        Math.floor((MAX_WAVEFORM_WINDOW_SECONDS * current.samplerate) / 128),
      ),
    );
  };

  const clampWaveformWindow = (start, end, anchor = "center") => {
    const totalFrames = Math.max(getTotalFrames(), 1);
    const maxSpan = Math.min(getMaxWaveformWindowFrames(), totalFrames);
    let nextStart = Math.min(start, end);
    let nextEnd = Math.max(start, end);
    let span = Math.max(nextEnd - nextStart, 1);

    if (span > maxSpan) {
      if (anchor === "start") {
        nextEnd = nextStart + maxSpan;
      } else if (anchor === "end") {
        nextStart = nextEnd - maxSpan;
      } else {
        const center = (nextStart + nextEnd) / 2;
        nextStart = center - maxSpan / 2;
        nextEnd = center + maxSpan / 2;
      }
      span = maxSpan;
    }

    nextStart = clamp(nextStart, 0, Math.max(0, totalFrames - span));
    nextEnd = nextStart + span;

    return {
      start: nextStart,
      end: Math.max(nextStart + 1, nextEnd),
    };
  };

  visibleWindowChangeRef.current = (view = viewRef.current) => {
    if (typeof onVisibleWindowChange !== "function") {
      return;
    }

    const snappedStart = Math.max(0, Math.floor(view.start));
    const snappedEnd = Math.max(snappedStart + 1, Math.ceil(view.end));
    onVisibleWindowChange(snappedStart, snappedEnd);
  };

  const clampView = (
    start,
    end,
    rowStart = viewRef.current.rowStart,
    rowEnd = viewRef.current.rowEnd,
  ) => {
    return clampRecordingView(start, end, rowStart, rowEnd);
  };

  const clampRecordingView = (
    start,
    end,
    rowStart = viewRef.current.rowStart,
    rowEnd = viewRef.current.rowEnd,
    options = {},
  ) => {
    const {
      minFrames = MIN_VIEW_FRAMES,
      minRows = MIN_VIEW_ROWS,
      snapFrames = false,
      snapRows = false,
    } = options;
    const totalFrames = Math.max(getTotalFrames(), 1);
    const rows = propsRef.current.data[0]?.length || 1;
    const maxRow = Math.max(rows - 1, 1);
    const availableFrames = Math.max(totalFrames, 1);
    const rawStart = snapFrames ? Math.floor(start) : start;
    const rawEnd = snapFrames ? Math.ceil(end) : end;
    const minWidth = Math.min(Math.max(minFrames, 1), availableFrames);
    const width = clamp(rawEnd - rawStart, minWidth, availableFrames);
    const availableRows = Math.max(maxRow, 1);
    const rawRowStart = snapRows ? Math.floor(rowStart) : rowStart;
    const rawRowEnd = snapRows ? Math.ceil(rowEnd) : rowEnd;
    const minHeight = Math.min(Math.max(minRows, 1), availableRows);
    const height = clamp(rawRowEnd - rawRowStart, minHeight, availableRows);
    const clampedStart = clamp(rawStart, 0, Math.max(0, totalFrames - width));
    const clampedRowStart = clamp(rawRowStart, 0, Math.max(0, maxRow - height));

    return {
      start: clampedStart,
      end: clampedStart + width,
      rowStart: clampedRowStart,
      rowEnd: clampedRowStart + height,
    };
  };

  const getCanonicalView = (
    rowStart = viewRef.current.rowStart,
    rowEnd = viewRef.current.rowEnd,
  ) => {
    const current = propsRef.current;
    const fallbackStart = current.offset;
    const fallbackEnd = current.offset + current.data.length;
    const start = Number.isFinite(current.visibleStart)
      ? current.visibleStart
      : fallbackStart;
    const end =
      Number.isFinite(current.visibleEnd) && current.visibleEnd > start
        ? current.visibleEnd
        : Math.max(start + 1, fallbackEnd);

    return clampRecordingView(start, end, rowStart, rowEnd, {
      minFrames: 1,
      minRows: 1,
      snapFrames: true,
    });
  };

  const getSpectrogramPoint = (
    layout,
    point,
    view = viewRef.current,
    options = {},
  ) => {
    const { clampToLoaded = false } = options;
    const rows = propsRef.current.data[0]?.length || 1;
    const xRatio = clamp(
      (point.x - layout.spectrogram.x) / Math.max(layout.spectrogram.width, 1),
      0,
      1,
    );
    const yRatio = clamp(
      1 -
        (point.y - layout.spectrogram.y) /
          Math.max(layout.spectrogram.height, 1),
      0,
      1,
    );

    return {
      frameIndex: clamp(
        view.start + xRatio * (view.end - view.start),
        clampToLoaded ? propsRef.current.offset : 0,
        clampToLoaded
          ? propsRef.current.offset + propsRef.current.data.length - 1
          : Math.max(getTotalFrames() - 1, 1),
      ),
      rowIndex: clamp(
        view.rowStart + yRatio * (view.rowEnd - view.rowStart),
        0,
        Math.max(rows - 1, 1),
      ),
    };
  };

  const getWaveformBand = (layout, view = viewRef.current) => {
    const totalFrames = Math.max(getTotalFrames(), 1);
    const bandStartRatio = clamp(view.start / totalFrames, 0, 1);
    const bandEndRatio = clamp(view.end / totalFrames, 0, 1);

    return {
      x: layout.waveform.x + bandStartRatio * layout.waveform.width,
      width: (bandEndRatio - bandStartRatio) * layout.waveform.width,
    };
  };

  const getWaveformEdgeHit = (layout, pointX, view = getDisplayedView()) => {
    const band = getWaveformBand(layout, view);
    const startDistance = Math.abs(pointX - band.x);
    const endDistance = Math.abs(pointX - (band.x + band.width));
    const hitPadding = WAVEFORM_EDGE_HIT_PIXELS;

    if (
      pointX >= band.x - hitPadding &&
      pointX <= band.x + hitPadding &&
      startDistance <= endDistance
    ) {
      return "start";
    }
    if (
      pointX >= band.x + band.width - hitPadding &&
      pointX <= band.x + band.width + hitPadding
    ) {
      return "end";
    }
    return null;
  };

  const getDisplayedView = () => {
    return getCanonicalView();
  };

  const getActiveWaveformView = () => {
    const selection = interactionRef.current.waveformSelection;
    if (selection && selection.active) {
      return {
        start: selection.startFrame,
        end: selection.endFrame,
      };
    }

    return getDisplayedView();
  };

  const requestWaveformWindow = (start, end, anchor = "center") => {
    const totalFrames = Math.max(getTotalFrames(), 1);
    const maxRow = Math.max((propsRef.current.data[0]?.length || 1) - 1, 1);
    const clampedWindow = clampWaveformWindow(
      Math.floor(start),
      Math.ceil(end),
      anchor,
    );
    const nextStart = clamp(
      Math.floor(clampedWindow.start),
      0,
      Math.max(0, totalFrames - 1),
    );
    const nextEnd = clamp(
      Math.ceil(clampedWindow.end),
      nextStart + 1,
      Math.max(nextStart + 1, Math.ceil(totalFrames)),
    );
    const nextView = clampRecordingView(nextStart, nextEnd, 0, maxRow, {
      minFrames: 1,
      minRows: 1,
      snapFrames: true,
    });
    viewRef.current = nextView;
    setSpectrumFrame((nextView.start + nextView.end) / 2);
    visibleWindowChangeRef.current?.(nextView);
    scheduleDrawRef.current?.();
  };

  const requestSpectrogramWindow = (targetView, options = {}) => {
    const nextView = clampRecordingView(
      targetView.start,
      targetView.end,
      targetView.rowStart,
      targetView.rowEnd,
      options,
    );
    viewRef.current = nextView;
    setSpectrumFrame((nextView.start + nextView.end) / 2);
    visibleWindowChangeRef.current?.(nextView);
    scheduleDrawRef.current?.();
    return true;
  };

  const setSpectrumFrame = (frameIndex) => {
    const glState = glStateRef.current;
    const current = propsRef.current;
    if (!glState) {
      return;
    }

    const columnIndex = clamp(
      Math.round(frameIndex - current.offset),
      0,
      Math.max(current.data.length - 1, 0),
    );
    const points = buildSpectrumPoints(current.data, columnIndex);
    updateBuffer(
      glState.gl,
      glState.spectrumBuffer,
      points,
      glState.gl.DYNAMIC_DRAW,
    );
    glState.spectrumCount = points.length / 2;
  };

  const getLayoutForPointer = () => {
    const container = containerRef.current;
    if (!container) {
      return null;
    }
    return getLayout(container.clientWidth, container.clientHeight);
  };

  const getPointerPosition = (event) => {
    const container = containerRef.current;
    if (!container) {
      return null;
    }

    const bounds = container.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  };

  const setContainerCursor = (cursor = "") => {
    const container = containerRef.current;
    if (!container || cursorRef.current === cursor) {
      return;
    }
    container.style.cursor = cursor;
    cursorRef.current = cursor;
  };

  scheduleDrawRef.current = () => {
    if (rafRef.current !== null) {
      return;
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const container = containerRef.current;
      const glCanvas = glCanvasRef.current;
      const overlayCanvas = overlayCanvasRef.current;
      const glState = glStateRef.current;

      if (!container || !glCanvas || !overlayCanvas || !glState) {
        return;
      }

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) {
        return;
      }

      const dpr = getPixelRatio();
      const canvasWidth = Math.max(1, Math.round(width * dpr));
      const canvasHeight = Math.max(1, Math.round(height * dpr));
      if (glCanvas.width !== canvasWidth || glCanvas.height !== canvasHeight) {
        glCanvas.width = canvasWidth;
        glCanvas.height = canvasHeight;
      }
      if (
        overlayCanvas.width !== canvasWidth ||
        overlayCanvas.height !== canvasHeight
      ) {
        overlayCanvas.width = canvasWidth;
        overlayCanvas.height = canvasHeight;
      }

      const layout = getLayout(width, height);
      const pixelSpectrogram = toDeviceRect(layout.spectrogram, dpr, height);
      const pixelWaveform = toDeviceRect(layout.waveform, dpr, height);
      const pixelSpectrum = toDeviceRect(layout.spectrum, dpr, height);
      const current = propsRef.current;
      const rows = current.data[0]?.length || 0;
      const view = getCanonicalView();
      viewRef.current = view;

      const { gl } = glState;
      gl.viewport(0, 0, canvasWidth, canvasHeight);
      gl.clearColor(0.07, 0.07, 0.09, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);

      if (glState.textureWidth > 0 && glState.textureHeight > 0) {
        gl.viewport(
          pixelSpectrogram.x,
          pixelSpectrogram.y,
          pixelSpectrogram.width,
          pixelSpectrogram.height,
        );
        gl.scissor(
          pixelSpectrogram.x,
          pixelSpectrogram.y,
          pixelSpectrogram.width,
          pixelSpectrogram.height,
        );
        gl.useProgram(glState.spectrogramProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, glState.spectrogramTexture);
        gl.uniform1i(glState.spectrogramUniforms.texture, 0);
        gl.uniform1f(glState.spectrogramUniforms.loadedStart, current.offset);
        gl.uniform1f(glState.spectrogramUniforms.viewStart, view.start);
        gl.uniform1f(
          glState.spectrogramUniforms.viewSpan,
          view.end - view.start,
        );
        gl.uniform1f(glState.spectrogramUniforms.viewRowStart, view.rowStart);
        gl.uniform1f(
          glState.spectrogramUniforms.viewRowSpan,
          view.rowEnd - view.rowStart,
        );
        gl.uniform2f(
          glState.spectrogramUniforms.textureSize,
          glState.textureWidth,
          glState.textureHeight,
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.quadBuffer);
        gl.enableVertexAttribArray(glState.spectrogramAttributes.position);
        gl.vertexAttribPointer(
          glState.spectrogramAttributes.position,
          2,
          gl.FLOAT,
          false,
          0,
          0,
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      if (glState.waveformCount > 1) {
        gl.viewport(
          pixelWaveform.x,
          pixelWaveform.y,
          pixelWaveform.width,
          pixelWaveform.height,
        );
        gl.scissor(
          pixelWaveform.x,
          pixelWaveform.y,
          pixelWaveform.width,
          pixelWaveform.height,
        );
        gl.useProgram(glState.lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.waveformBuffer);
        gl.enableVertexAttribArray(glState.lineAttributes.point);
        gl.vertexAttribPointer(
          glState.lineAttributes.point,
          2,
          gl.FLOAT,
          false,
          0,
          0,
        );
        gl.uniform2f(
          glState.lineUniforms.domainX,
          0,
          Math.max(getTotalFrames(), 1),
        );
        gl.uniform2f(
          glState.lineUniforms.domainY,
          -waveformAmplitudeRef.current,
          waveformAmplitudeRef.current,
        );
        gl.uniform4f(glState.lineUniforms.color, 0.4, 0.75, 0.72, 1);
        gl.drawArrays(gl.LINE_STRIP, 0, glState.waveformCount);
      }

      if (glState.spectrumCount > 1 && rows > 0) {
        gl.viewport(
          pixelSpectrum.x,
          pixelSpectrum.y,
          pixelSpectrum.width,
          pixelSpectrum.height,
        );
        gl.scissor(
          pixelSpectrum.x,
          pixelSpectrum.y,
          pixelSpectrum.width,
          pixelSpectrum.height,
        );
        gl.useProgram(glState.lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.spectrumBuffer);
        gl.enableVertexAttribArray(glState.lineAttributes.point);
        gl.vertexAttribPointer(
          glState.lineAttributes.point,
          2,
          gl.FLOAT,
          false,
          0,
          0,
        );
        gl.uniform2f(glState.lineUniforms.domainX, 0, SPECTRUM_DOMAIN_MAX);
        gl.uniform2f(glState.lineUniforms.domainY, view.rowStart, view.rowEnd);
        gl.uniform4f(glState.lineUniforms.color, 0.4, 0.75, 0.72, 0.98);
        gl.drawArrays(gl.LINE_STRIP, 0, glState.spectrumCount);
      }

      gl.disable(gl.SCISSOR_TEST);

      const ctx = overlayCanvas.getContext("2d");
      if (!ctx) {
        return;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      drawPanelFrame(ctx, layout.spectrogram);
      drawPanelFrame(ctx, layout.waveform);
      drawPanelFrame(ctx, layout.spectrum);

      const xTicks = createTicks(view.start, view.end, 6);
      const xTickPositions = xTicks.map((tick) => ({
        value: tick,
        position:
          layout.spectrogram.x +
          ((tick - view.start) / Math.max(view.end - view.start, 1)) *
            layout.spectrogram.width,
      }));
      drawGrid(
        ctx,
        layout.spectrogram,
        xTickPositions.map((tick) => tick.position),
        "x",
      );

      const yTicks = createTicks(
        view.rowStart,
        Math.max(view.rowEnd, view.rowStart + 1),
        5,
      );
      const yTickPositions = yTicks.map((tick) => ({
        value: tick,
        position:
          layout.spectrogram.y +
          layout.spectrogram.height -
          ((tick - view.rowStart) / Math.max(view.rowEnd - view.rowStart, 1)) *
            layout.spectrogram.height,
      }));
      drawGrid(
        ctx,
        layout.spectrogram,
        yTickPositions.map((tick) => tick.position),
        "y",
      );
      drawGrid(
        ctx,
        layout.spectrum,
        yTickPositions.map((tick) => tick.position),
        "y",
      );

      drawTickLabels({
        ctx,
        values: yTickPositions,
        formatter: (value) => formatNumber(rowToFrequency(value)),
        axis: "y",
        rect: layout.spectrogram,
        gap: 8,
      });
      drawTickLabels({
        ctx,
        values: yTickPositions,
        formatter: (value) => formatNumber(rowToFrequency(value)),
        axis: "y",
        rect: layout.spectrum,
        side: "right",
        gap: 8,
      });

      const waveformTicks = createTicks(
        0,
        Math.max(getTotalFrames(), 1),
        6,
      ).map((tick) => ({
        value: tick,
        position:
          layout.waveform.x +
          (tick / Math.max(getTotalFrames(), 1)) * layout.waveform.width,
      }));
      drawGrid(
        ctx,
        layout.waveform,
        waveformTicks.map((tick) => tick.position),
        "x",
      );
      drawTickLabels({
        ctx,
        values: waveformTicks,
        formatter: (value) => formatNumber(frameToSeconds(value)),
        axis: "x",
        rect: layout.waveform,
      });

      drawLabel(
        ctx,
        "Frequency (kHz)",
        layout.spectrogram.x,
        layout.spectrogram.y - 8,
      );
      drawLabel(ctx, "Spectrum", layout.spectrum.x, layout.spectrum.y - 8, {
        color: MUTED_LABEL_COLOR,
      });
      drawLabel(ctx, "Waveform", layout.waveform.x, layout.waveform.y - 8, {
        color: MUTED_LABEL_COLOR,
      });
      drawLabel(
        ctx,
        "Time (s)",
        layout.waveform.x + layout.waveform.width / 2,
        layout.waveform.y + layout.waveform.height + 26,
        { align: "center" },
      );

      const totalFrames = Math.max(getTotalFrames(), 1);
      const activeWaveformView = getActiveWaveformView();
      const waveformBand = getWaveformBand(layout, activeWaveformView);
      ctx.fillStyle = "rgba(102, 192, 183, 0.16)";
      ctx.fillRect(
        waveformBand.x,
        layout.waveform.y,
        waveformBand.width,
        layout.waveform.height,
      );
      ctx.strokeStyle = "rgba(102, 192, 183, 0.72)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        waveformBand.x + 0.75,
        layout.waveform.y + 0.75,
        Math.max(waveformBand.width - 1.5, 0),
        layout.waveform.height - 1.5,
      );

      let playheadFrame = null;
      if (
        current.playbackCursor &&
        Number.isFinite(current.playbackCursor.startFrameIndex) &&
        Number.isFinite(current.playbackCursor.endFrameIndex) &&
        Number.isFinite(current.playbackCursor.durationMs)
      ) {
        const elapsed = performance.now() - current.playbackCursor.startedAtMs;
        const progress =
          current.playbackCursor.durationMs <= 0
            ? 1
            : clamp(elapsed / current.playbackCursor.durationMs, 0, 1);
        playheadFrame =
          current.playbackCursor.startFrameIndex +
          (current.playbackCursor.endFrameIndex -
            current.playbackCursor.startFrameIndex) *
            progress;
      }

      if (playheadFrame !== null) {
        if (playheadFrame >= view.start && playheadFrame <= view.end) {
          const x =
            layout.spectrogram.x +
            ((playheadFrame - view.start) /
              Math.max(view.end - view.start, 1)) *
              layout.spectrogram.width;
          ctx.strokeStyle = PLAYHEAD_COLOR;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, layout.spectrogram.y);
          ctx.lineTo(x, layout.spectrogram.y + layout.spectrogram.height);
          ctx.stroke();
        }

        const waveformX =
          layout.waveform.x +
          (playheadFrame / totalFrames) * layout.waveform.width;
        ctx.strokeStyle = PLAYHEAD_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(waveformX, layout.waveform.y);
        ctx.lineTo(waveformX, layout.waveform.y + layout.waveform.height);
        ctx.stroke();
      }

      if (hoverRef.current.active && rows > 0) {
        const hoverX =
          layout.spectrogram.x +
          ((hoverRef.current.frameIndex - view.start) /
            Math.max(view.end - view.start, 1)) *
            layout.spectrogram.width;
        const hoverY =
          layout.spectrogram.y +
          layout.spectrogram.height -
          ((hoverRef.current.rowIndex - view.rowStart) /
            Math.max(view.rowEnd - view.rowStart, 1)) *
            layout.spectrogram.height;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hoverX, layout.spectrogram.y);
        ctx.lineTo(hoverX, layout.spectrogram.y + layout.spectrogram.height);
        ctx.stroke();

        const tooltipText = `${formatNumber(frameToSeconds(hoverRef.current.frameIndex))} s  |  ${formatNumber(rowToFrequency(hoverRef.current.rowIndex))} kHz`;
        ctx.font = "12px sans-serif";
        const tooltipWidth = ctx.measureText(tooltipText).width + 16;
        const tooltipX = clamp(
          hoverX + 12,
          layout.spectrogram.x + 8,
          layout.spectrogram.x + layout.spectrogram.width - tooltipWidth - 8,
        );
        const tooltipY = clamp(
          hoverY - 28,
          layout.spectrogram.y + 8,
          layout.spectrogram.y + layout.spectrogram.height - 28,
        );
        ctx.fillStyle = "rgba(10, 11, 15, 0.9)";
        ctx.fillRect(tooltipX, tooltipY, tooltipWidth, 22);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.strokeRect(tooltipX + 0.5, tooltipY + 0.5, tooltipWidth - 1, 21);
        drawLabel(ctx, tooltipText, tooltipX + 8, tooltipY + 15, {
          color: LABEL_COLOR,
        });
      }

      if (interactionRef.current.spectrogramSelection?.active) {
        const selectionBox = interactionRef.current.spectrogramSelection;
        const x1 =
          layout.spectrogram.x +
          ((selectionBox.startFrame - view.start) /
            Math.max(view.end - view.start, 1)) *
            layout.spectrogram.width;
        const x2 =
          layout.spectrogram.x +
          ((selectionBox.endFrame - view.start) /
            Math.max(view.end - view.start, 1)) *
            layout.spectrogram.width;
        const y1 =
          layout.spectrogram.y +
          layout.spectrogram.height -
          ((selectionBox.startRow - view.rowStart) /
            Math.max(view.rowEnd - view.rowStart, 1)) *
            layout.spectrogram.height;
        const y2 =
          layout.spectrogram.y +
          layout.spectrogram.height -
          ((selectionBox.endRow - view.rowStart) /
            Math.max(view.rowEnd - view.rowStart, 1)) *
            layout.spectrogram.height;
        const boxX = Math.min(x1, x2);
        const boxY = Math.min(y1, y2);
        const boxWidth = Math.abs(x2 - x1);
        const boxHeight = Math.abs(y2 - y1);

        ctx.save();
        ctx.fillStyle = "rgba(102, 192, 183, 0.12)";
        ctx.strokeStyle = "rgba(102, 192, 183, 0.88)";
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
        ctx.strokeRect(
          boxX + 0.75,
          boxY + 0.75,
          boxWidth - 1.5,
          boxHeight - 1.5,
        );
        ctx.restore();
      }
    });
  };

  const scheduleDraw = () => {
    scheduleDrawRef.current?.();
  };

  // This effect intentionally reads the latest canonical window through refs.
  // The x-range is owned by App; this sync just mirrors it into the renderer.
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!glCanvas) {
      return undefined;
    }

    try {
      const gl = glCanvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: false,
      });

      if (!gl) {
        setWebglError("WebGL2 is not available in this environment.");
        return undefined;
      }

      const spectrogramProgram = createProgram(
        gl,
        SPECTROGRAM_VERTEX_SOURCE,
        SPECTROGRAM_FRAGMENT_SOURCE,
      );
      const lineProgram = createProgram(
        gl,
        LINE_VERTEX_SOURCE,
        LINE_FRAGMENT_SOURCE,
      );

      const glState = {
        gl,
        spectrogramProgram,
        lineProgram,
        spectrogramTexture: createTexture(gl),
        textureWidth: 0,
        textureHeight: 0,
        quadBuffer: gl.createBuffer(),
        waveformBuffer: gl.createBuffer(),
        waveformCount: 0,
        spectrumBuffer: gl.createBuffer(),
        spectrumCount: 0,
        spectrogramAttributes: {
          position: gl.getAttribLocation(spectrogramProgram, "aPosition"),
        },
        spectrogramUniforms: {
          texture: gl.getUniformLocation(spectrogramProgram, "uTexture"),
          loadedStart: gl.getUniformLocation(
            spectrogramProgram,
            "uLoadedStart",
          ),
          viewStart: gl.getUniformLocation(spectrogramProgram, "uViewStart"),
          viewSpan: gl.getUniformLocation(spectrogramProgram, "uViewSpan"),
          viewRowStart: gl.getUniformLocation(
            spectrogramProgram,
            "uViewRowStart",
          ),
          viewRowSpan: gl.getUniformLocation(
            spectrogramProgram,
            "uViewRowSpan",
          ),
          textureSize: gl.getUniformLocation(
            spectrogramProgram,
            "uTextureSize",
          ),
        },
        lineAttributes: {
          point: gl.getAttribLocation(lineProgram, "aPoint"),
        },
        lineUniforms: {
          domainX: gl.getUniformLocation(lineProgram, "uDomainX"),
          domainY: gl.getUniformLocation(lineProgram, "uDomainY"),
          color: gl.getUniformLocation(lineProgram, "uColor"),
        },
      };

      gl.bindBuffer(gl.ARRAY_BUFFER, glState.quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      glStateRef.current = glState;
      setWebglError("");
      scheduleDrawRef.current?.();
    } catch (error) {
      setWebglError(
        error.message || "Failed to initialize the spectrogram renderer.",
      );
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (playbackRafRef.current !== null) {
        cancelAnimationFrame(playbackRafRef.current);
        playbackRafRef.current = null;
      }
      destroyGlState(glStateRef.current);
      glStateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (
      !Number.isFinite(visibleStart) ||
      !Number.isFinite(visibleEnd) ||
      visibleEnd <= visibleStart
    ) {
      return;
    }

    viewRef.current = getCanonicalView();
    scheduleDrawRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleStart, visibleEnd]);

  // Rebuild the WebGL texture while preserving the canonical x-window.
  useEffect(() => {
    const glState = glStateRef.current;
    if (!glState) {
      return;
    }

    const flattened = flattenSpectrogram(data);
    glState.textureWidth = flattened.width;
    glState.textureHeight = flattened.height;
    if (flattened.width > 0 && flattened.height > 0) {
      updateTexture(
        glState.gl,
        glState.spectrogramTexture,
        flattened.width,
        flattened.height,
        flattened.pixels,
      );
    }

    const rows = data[0]?.length || 1;
    const maxRow = Math.max(rows - 1, 1);
    const currentView = getCanonicalView();
    const rowSpan = clamp(
      currentView.rowEnd - currentView.rowStart,
      1,
      Math.max(maxRow, 1),
    );
    const nextRowStart = clamp(
      currentView.rowStart,
      0,
      Math.max(0, maxRow - rowSpan),
    );
    viewRef.current = {
      start: currentView.start,
      end: currentView.end,
      rowStart: nextRowStart,
      rowEnd: nextRowStart + rowSpan,
    };

    hoverRef.current.active = false;
    setSpectrumFrame(viewRef.current.start);
    scheduleDrawRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, offset]);

  useEffect(() => {
    const glState = glStateRef.current;
    if (!glState) {
      return;
    }

    const waveform = buildWaveformPoints(waveData, getTotalFrames());
    waveformAmplitudeRef.current = waveform.amplitude;
    updateBuffer(glState.gl, glState.waveformBuffer, waveform.points);
    glState.waveformCount = waveform.points.length / 2;
    scheduleDrawRef.current?.();
  }, [waveData]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const redraw = () => {
      scheduleDrawRef.current?.();
    };
    const observer = new ResizeObserver(redraw);
    observer.observe(container);
    window.addEventListener("resize", redraw);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, []);

  useEffect(() => {
    if (playbackRafRef.current !== null) {
      cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = null;
    }

    if (
      !playbackCursor ||
      !Number.isFinite(playbackCursor.startFrameIndex) ||
      !Number.isFinite(playbackCursor.endFrameIndex) ||
      !Number.isFinite(playbackCursor.durationMs)
    ) {
      scheduleDrawRef.current?.();
      return undefined;
    }

    const animate = () => {
      scheduleDrawRef.current?.();
      const elapsed = performance.now() - playbackCursor.startedAtMs;
      if (elapsed < playbackCursor.durationMs) {
        playbackRafRef.current = requestAnimationFrame(animate);
      } else {
        playbackRafRef.current = null;
        scheduleDrawRef.current?.();
      }
    };

    playbackRafRef.current = requestAnimationFrame(animate);
    return () => {
      if (playbackRafRef.current !== null) {
        cancelAnimationFrame(playbackRafRef.current);
        playbackRafRef.current = null;
      }
    };
  }, [playbackCursor]);

  const handlePointerMove = (event) => {
    const layout = getLayoutForPointer();
    const point = getPointerPosition(event);
    if (!layout || !point) {
      return;
    }

    const interaction = interactionRef.current;
    const rows = propsRef.current.data[0]?.length || 0;
    const spectrogramRect = layout.spectrogram;
    const waveformRect = layout.waveform;
    const view = viewRef.current;

    if (interaction.dragMode === "spectrogram-zoom") {
      setContainerCursor("crosshair");
      const nextPoint = getSpectrogramPoint(layout, point, view, {
        clampToLoaded: false,
      });
      interaction.spectrogramSelection = {
        active: true,
        startFrame: interaction.viewStart,
        endFrame: nextPoint.frameIndex,
        startRow: interaction.viewRowStart,
        endRow: nextPoint.rowIndex,
      };
      interaction.moved =
        interaction.moved ||
        Math.abs(point.x - interaction.startX) > 4 ||
        Math.abs(point.y - interaction.startY) > 4;
      scheduleDraw();
      return;
    }

    if (interaction.dragMode === "waveform-move") {
      setContainerCursor("grabbing");
      const totalFrames = Math.max(getTotalFrames(), 1);
      const frame =
        ((clamp(point.x, waveformRect.x, waveformRect.x + waveformRect.width) -
          waveformRect.x) /
          Math.max(waveformRect.width, 1)) *
        totalFrames;
      const span = interaction.viewEnd - interaction.viewStart;
      const nextStart = clamp(
        interaction.viewStart + (frame - interaction.anchorFrame),
        0,
        Math.max(0, totalFrames - span),
      );
      interaction.waveformSelection = {
        active: true,
        startFrame: nextStart,
        endFrame: nextStart + span,
      };
      interaction.moved =
        interaction.moved ||
        Math.abs(point.x - interaction.startX) > 3 ||
        Math.abs(point.y - interaction.startY) > 3;
      scheduleDraw();
      return;
    }

    if (interaction.dragMode === "waveform-resize-start") {
      setContainerCursor("ew-resize");
      const totalFrames = Math.max(getTotalFrames(), 1);
      const frame =
        ((clamp(point.x, waveformRect.x, waveformRect.x + waveformRect.width) -
          waveformRect.x) /
          Math.max(waveformRect.width, 1)) *
        totalFrames;
      const clampedWindow = clampWaveformWindow(
        frame,
        interaction.viewEnd,
        "end",
      );
      interaction.waveformSelection = {
        active: true,
        startFrame: clampedWindow.start,
        endFrame: clampedWindow.end,
      };
      interaction.moved =
        interaction.moved ||
        Math.abs(point.x - interaction.startX) > 3 ||
        Math.abs(point.y - interaction.startY) > 3;
      scheduleDraw();
      return;
    }

    if (interaction.dragMode === "waveform-resize-end") {
      setContainerCursor("ew-resize");
      const totalFrames = Math.max(getTotalFrames(), 1);
      const frame =
        ((clamp(point.x, waveformRect.x, waveformRect.x + waveformRect.width) -
          waveformRect.x) /
          Math.max(waveformRect.width, 1)) *
        totalFrames;
      const clampedWindow = clampWaveformWindow(
        interaction.viewStart,
        frame,
        "start",
      );
      interaction.waveformSelection = {
        active: true,
        startFrame: clampedWindow.start,
        endFrame: clampedWindow.end,
      };
      interaction.moved =
        interaction.moved ||
        Math.abs(point.x - interaction.startX) > 3 ||
        Math.abs(point.y - interaction.startY) > 3;
      scheduleDraw();
      return;
    }

    if (interaction.dragMode === "waveform-select") {
      setContainerCursor("crosshair");
      const totalFrames = Math.max(getTotalFrames(), 1);
      const frame =
        ((clamp(point.x, waveformRect.x, waveformRect.x + waveformRect.width) -
          waveformRect.x) /
          Math.max(waveformRect.width, 1)) *
        totalFrames;
      const anchorMode = frame >= interaction.anchorFrame ? "start" : "end";
      const clampedWindow = clampWaveformWindow(
        interaction.anchorFrame,
        frame,
        anchorMode,
      );
      interaction.waveformSelection = {
        active: true,
        startFrame: clampedWindow.start,
        endFrame: clampedWindow.end,
      };
      interaction.moved =
        interaction.moved ||
        Math.abs(point.x - interaction.startX) > 3 ||
        Math.abs(point.y - interaction.startY) > 3;
      scheduleDraw();
      return;
    }

    if (isPointInside(spectrogramRect, point.x, point.y) && rows > 0) {
      setContainerCursor("crosshair");
      const { frameIndex, rowIndex } = getSpectrogramPoint(layout, point, view);
      hoverRef.current = {
        active: true,
        frameIndex,
        rowIndex,
      };
      setSpectrumFrame(frameIndex);
      scheduleDraw();
      return;
    }

    if (isPointInside(waveformRect, point.x, point.y)) {
      const activeWaveformView = getActiveWaveformView();
      const band = getWaveformBand(layout, activeWaveformView);
      const edgeHit = getWaveformEdgeHit(layout, point.x, activeWaveformView);
      if (edgeHit) {
        setContainerCursor("ew-resize");
      } else if (point.x >= band.x && point.x <= band.x + band.width) {
        setContainerCursor("grab");
      } else {
        setContainerCursor("crosshair");
      }
      return;
    }

    setContainerCursor("");
    if (hoverRef.current.active) {
      hoverRef.current.active = false;
      scheduleDraw();
    }
  };

  const handlePointerDown = (event) => {
    const layout = getLayoutForPointer();
    const point = getPointerPosition(event);
    if (!layout || !point) {
      return;
    }

    const interaction = interactionRef.current;
    interaction.pointerId = event.pointerId;
    interaction.startX = point.x;
    interaction.startY = point.y;
    interaction.moved = false;
    interaction.spectrogramSelection = null;

    if (isPointInside(layout.spectrogram, point.x, point.y)) {
      const specPoint = getSpectrogramPoint(layout, point, viewRef.current, {
        clampToLoaded: false,
      });
      interaction.dragMode = "spectrogram-zoom";
      interaction.viewStart = specPoint.frameIndex;
      interaction.viewRowStart = specPoint.rowIndex;
      interaction.spectrogramSelection = {
        active: true,
        startFrame: specPoint.frameIndex,
        endFrame: specPoint.frameIndex,
        startRow: specPoint.rowIndex,
        endRow: specPoint.rowIndex,
      };
      containerRef.current?.setPointerCapture(event.pointerId);
      scheduleDraw();
      return;
    }

    if (isPointInside(layout.waveform, point.x, point.y)) {
      const activeWaveformView = getActiveWaveformView();
      const band = getWaveformBand(layout, activeWaveformView);
      const edgeHit = getWaveformEdgeHit(layout, point.x, activeWaveformView);
      const frame =
        ((clamp(
          point.x,
          layout.waveform.x,
          layout.waveform.x + layout.waveform.width,
        ) -
          layout.waveform.x) /
          Math.max(layout.waveform.width, 1)) *
        Math.max(getTotalFrames(), 1);
      interaction.viewStart = activeWaveformView.start;
      interaction.viewEnd = activeWaveformView.end;
      if (edgeHit === "start") {
        interaction.dragMode = "waveform-resize-start";
        interaction.waveformSelection = {
          active: true,
          startFrame: activeWaveformView.start,
          endFrame: activeWaveformView.end,
        };
      } else if (edgeHit === "end") {
        interaction.dragMode = "waveform-resize-end";
        interaction.waveformSelection = {
          active: true,
          startFrame: activeWaveformView.start,
          endFrame: activeWaveformView.end,
        };
      } else if (point.x >= band.x && point.x <= band.x + band.width) {
        interaction.dragMode = "waveform-move";
        interaction.anchorFrame = frame;
        interaction.waveformSelection = {
          active: true,
          startFrame: activeWaveformView.start,
          endFrame: activeWaveformView.end,
        };
      } else {
        interaction.dragMode = "waveform-select";
        interaction.anchorFrame = frame;
        interaction.waveformSelection = {
          active: true,
          startFrame: frame,
          endFrame: frame,
        };
      }
      containerRef.current?.setPointerCapture(event.pointerId);
      scheduleDraw();
    }
  };

  const handlePointerUp = () => {
    const interaction = interactionRef.current;
    if (
      interaction.pointerId !== null &&
      containerRef.current?.hasPointerCapture?.(interaction.pointerId)
    ) {
      containerRef.current.releasePointerCapture(interaction.pointerId);
    }

    if (interaction.dragMode === "spectrogram-zoom" && interaction.moved) {
      const selection = interaction.spectrogramSelection;
      if (selection) {
        const nextView = clampRecordingView(
          Math.min(selection.startFrame, selection.endFrame),
          Math.max(selection.startFrame, selection.endFrame),
          Math.min(selection.startRow, selection.endRow),
          Math.max(selection.startRow, selection.endRow),
          {
            minFrames: 1,
            minRows: 1,
            snapFrames: true,
            snapRows: true,
          },
        );
        requestSpectrogramWindow(nextView, {
          minFrames: 1,
          minRows: 1,
          snapFrames: true,
          snapRows: true,
        });
      }
    }

    if (
      (interaction.dragMode === "waveform-move" ||
        interaction.dragMode === "waveform-resize-start" ||
        interaction.dragMode === "waveform-resize-end") &&
      interaction.waveformSelection &&
      interaction.moved
    ) {
      const anchorMode =
        interaction.dragMode === "waveform-resize-start"
          ? "end"
          : interaction.dragMode === "waveform-resize-end"
            ? "start"
            : "center";
      requestWaveformWindow(
        interaction.waveformSelection.startFrame,
        interaction.waveformSelection.endFrame,
        anchorMode,
      );
    } else if (
      interaction.dragMode === "waveform-select" &&
      interaction.waveformSelection
    ) {
      const { startFrame, endFrame } = interaction.waveformSelection;
      if (interaction.moved && endFrame - startFrame > 6) {
        const anchorMode =
          interaction.anchorFrame <= startFrame + 0.5 ? "start" : "end";
        requestWaveformWindow(startFrame, endFrame, anchorMode);
      } else {
        const span = Math.max(interaction.viewEnd - interaction.viewStart, 1);
        const totalFrames = Math.max(getTotalFrames(), 1);
        const centeredStart = clamp(
          interaction.anchorFrame - span / 2,
          0,
          Math.max(0, totalFrames - span),
        );
        requestWaveformWindow(centeredStart, centeredStart + span, "center");
      }
    } else if (interaction.dragMode === "waveform-move" && !interaction.moved) {
      const span = Math.max(interaction.viewEnd - interaction.viewStart, 1);
      const totalFrames = Math.max(getTotalFrames(), 1);
      const centeredStart = clamp(
        interaction.anchorFrame - span / 2,
        0,
        Math.max(0, totalFrames - span),
      );
      if (span > 1) {
        requestWaveformWindow(centeredStart, centeredStart + span, "center");
      }
    }

    interaction.dragMode = null;
    interaction.pointerId = null;
    interaction.waveformSelection = null;
    interaction.spectrogramSelection = null;
    interaction.moved = false;
    setContainerCursor("");
    scheduleDraw();
  };

  const handlePointerLeave = () => {
    setContainerCursor("");
    if (!interactionRef.current.dragMode && hoverRef.current.active) {
      hoverRef.current.active = false;
      scheduleDraw();
    }
  };

  const handleWheel = (event) => {
    const layout = getLayoutForPointer();
    const point = getPointerPosition(event);
    if (
      !layout ||
      !point ||
      !isPointInside(layout.spectrogram, point.x, point.y)
    ) {
      return;
    }

    event.preventDefault();
    const view = viewRef.current;
    const span = view.end - view.start;
    const rowSpan = view.rowEnd - view.rowStart;
    const isTrackpadLike =
      event.deltaMode === 0 &&
      (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 24);
    const isZoomGesture = event.ctrlKey || !isTrackpadLike;

    let nextView;
    if (isZoomGesture) {
      const { frameIndex, rowIndex } = getSpectrogramPoint(
        layout,
        point,
        view,
        {
          clampToLoaded: false,
        },
      );
      const zoomFactor = Math.exp(event.deltaY * 0.01);
      const nextSpan = span * zoomFactor;
      const nextRowSpan = rowSpan * zoomFactor;
      const xRatio = clamp((frameIndex - view.start) / Math.max(span, 1), 0, 1);
      const yRatio = clamp(
        (rowIndex - view.rowStart) / Math.max(rowSpan, 1),
        0,
        1,
      );
      const nextStart = frameIndex - xRatio * nextSpan;
      const nextRowStart = rowIndex - yRatio * nextRowSpan;
      nextView = clampView(
        nextStart,
        nextStart + nextSpan,
        nextRowStart,
        nextRowStart + nextRowSpan,
      );
    } else {
      const targetView = clampRecordingView(
        view.start +
          (event.deltaX / Math.max(layout.spectrogram.width, 1)) * span,
        view.end +
          (event.deltaX / Math.max(layout.spectrogram.width, 1)) * span,
        view.rowStart +
          (-event.deltaY / Math.max(layout.spectrogram.height, 1)) * rowSpan,
        view.rowEnd +
          (-event.deltaY / Math.max(layout.spectrogram.height, 1)) * rowSpan,
      );
      nextView = clampView(
        targetView.start,
        targetView.end,
        targetView.rowStart,
        targetView.rowEnd,
      );
    }

    viewRef.current = nextView;
    if (!hoverRef.current.active) {
      setSpectrumFrame((nextView.start + nextView.end) / 2);
    }
    visibleWindowChangeRef.current?.(nextView);
    scheduleDraw();
  };

  const handleDoubleClick = (event) => {
    const layout = getLayoutForPointer();
    const point = getPointerPosition(event);
    if (
      !layout ||
      !point ||
      !isPointInside(layout.spectrogram, point.x, point.y)
    ) {
      return;
    }

    viewRef.current = {
      start: 0,
      end: Math.max(getTotalFrames(), 1),
      rowStart: 0,
      rowEnd: Math.max((propsRef.current.data[0]?.length || 1) - 1, 1),
    };
    if (!hoverRef.current.active) {
      setSpectrumFrame(viewRef.current.start);
    }
    visibleWindowChangeRef.current?.(viewRef.current);
    scheduleDraw();
  };

  return (
    <div
      id={id}
      ref={containerRef}
      className="gpuSpectrogramRoot"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
    >
      <canvas ref={glCanvasRef} className="gpuSpectrogramCanvas" />
      <canvas ref={overlayCanvasRef} className="gpuSpectrogramOverlay" />
      {webglError ? (
        <div className="gpuSpectrogramMessage">{webglError}</div>
      ) : null}
    </div>
  );
};

export default Spectrogram;
