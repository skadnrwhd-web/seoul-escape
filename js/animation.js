// animation.js — 경주 재생 상태 관리(RaceController)와 Canvas 그리기 함수.
// RaceController는 DOM을 쓰지 않아 Node 테스트에서도 검증할 수 있다.
// 그리기 함수는 게임 화면과 쇼츠 영상(recorder.js)이 함께 사용한다.

export const THEME = {
  bg: '#060814',
  bgGrad: '#0c1030',
  road: 'rgba(120, 140, 200, 0.28)',
  roadMajor: 'rgba(150, 170, 230, 0.4)',
  bridge: 'rgba(255, 140, 220, 0.75)',
  blocked: '#ff3b5c',
  river: '#0a2a5c',
  riverGlow: 'rgba(40, 140, 255, 0.25)',
  mountain: 'rgba(40, 90, 60, 0.45)',
  construction: 'rgba(255, 150, 40, 0.18)',
  district: 'rgba(190, 200, 255, 0.32)',
  dijkstra: '#2f8bff',
  dijkstraSoft: 'rgba(47, 139, 255, 0.16)',
  astar: '#22ff9a',
  astarSoft: 'rgba(34, 255, 154, 0.14)',
  start: '#ff2d55',
  goal: '#ffc531',
  path: '#fff7b0',
  text: '#eef1ff',
  textDim: '#9aa3d0',
  pink: '#ff4fd8',
  cyan: '#38e8ff',
};

export const FONT = '"Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';

export const ALGO_STYLE = {
  dijkstra: { label: 'DIJKSTRA', color: THEME.dijkstra, soft: THEME.dijkstraSoft },
  astar: { label: 'A*', color: THEME.astar, soft: THEME.astarSoft },
};

// ---------------------------------------------------------------------------
// 재생 상태 관리
// ---------------------------------------------------------------------------
/**
 * 상태: 'empty' → (load) → 'ready' → (start) → 'running' ⇄ 'paused' → 'finished'
 * restart()는 언제든 처음부터 다시 재생한다. load()는 진행 중인 재생을 멈추고 새 결과로 교체한다.
 * 재생은 '스텝' 단위로 진행된다. 1스텝 = 각 알고리즘이 노드 1개를 확장하는 것.
 */
export class RaceController {
  /**
   * @param stepsPerSecond 기본 재생 속도 (1배속 기준 초당 스텝)
   * @param targetSeconds  탐색이 아주 큰 경우(실제 도로망) 1배속에서 이 시간 안에 끝나도록 속도를 올린다
   */
  constructor({ stepsPerSecond = 60, speed = 1, targetSeconds = 12 } = {}) {
    this.stepsPerSecond = stepsPerSecond;
    this.targetSeconds = targetSeconds;
    this.rate = stepsPerSecond;
    this.speed = speed;
    this.state = 'empty';
    this.step = 0;
    this.race = null;
    this.generation = 0; // 새 결과를 불러올 때마다 증가 (이전 결과와 섞이지 않게)
  }

  load(race) {
    this.race = race;
    this.counts = {
      dijkstra: race.dijkstra.result.expandedOrder.length,
      astar: race.astar.result.expandedOrder.length,
    };
    this.maxSteps = Math.max(this.counts.dijkstra, this.counts.astar);
    this.pathSteps = Math.max(12, Math.round(this.maxSteps * 0.12));
    this.totalSteps = this.maxSteps + this.pathSteps;
    this.rate = Math.max(this.stepsPerSecond, this.maxSteps / this.targetSeconds);
    this.step = 0;
    this.state = 'ready';
    this.generation++;
    return this.generation;
  }

  start() {
    if (this.state === 'ready') { this.state = 'running'; return true; }
    if (this.state === 'finished') { this.step = 0; this.state = 'running'; return true; }
    return false; // 이미 실행 중이거나 일시정지 중이면 무시 (중복 시작 방지)
  }

  pause() {
    if (this.state !== 'running') return false;
    this.state = 'paused';
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'running';
    return true;
  }

  restart() {
    if (this.state === 'empty') return false;
    this.step = 0;
    this.state = 'running';
    return true;
  }

  /** 애니메이션을 건너뛰고 결과 화면으로 */
  finish() {
    if (this.state === 'empty') return false;
    this.step = this.totalSteps;
    this.state = 'finished';
    return true;
  }

  /** 결과 없음 상태로 (잘못된 출발/도착 등) */
  clear() {
    this.race = null;
    this.step = 0;
    this.state = 'empty';
    this.generation++;
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Math.min(10, speed));
  }

  /** dtSeconds만큼 시간을 진행. 상태가 바뀌면 새 상태를 반환. */
  tick(dtSeconds) {
    if (this.state !== 'running') return null;
    this.step = Math.min(this.totalSteps, this.step + dtSeconds * this.rate * this.speed);
    if (this.step >= this.totalSteps) {
      this.state = 'finished';
      return 'finished';
    }
    return null;
  }

  /** 특정 알고리즘의 현재 표시 상태 */
  view(algo) {
    return viewAtStep(this.counts[algo], this.step, this.pathSteps);
  }
}

/** 스텝 위치에서 한 알고리즘이 보여줄 내용 (게임과 영상이 같은 규칙 사용) */
export function viewAtStep(count, step, pathSteps) {
  const shown = Math.min(count, Math.floor(step));
  const done = step >= count;
  const pathProgress = done ? Math.max(0, Math.min(1, (step - count) / pathSteps)) : 0;
  return { shown, done, pathProgress };
}

// ---------------------------------------------------------------------------
// 좌표 변환
// ---------------------------------------------------------------------------
export function makeViewport(bounds, rect, pad = 0.04) {
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  const padPx = Math.min(rect.w, rect.h) * pad;
  const scale = Math.min((rect.w - 2 * padPx) / bw, (rect.h - 2 * padPx) / bh);
  const ox = rect.x + (rect.w - bw * scale) / 2 - bounds.minX * scale;
  const oy = rect.y + (rect.h - bh * scale) / 2 - bounds.minY * scale;
  return {
    rect,
    scale,
    ui: rect.w / 640, // 선 굵기·글자 크기 기준 배율
    sx: (x) => ox + x * scale,
    sy: (y) => oy + y * scale,
    toWorld: (px, py) => ({ x: (px - ox) / scale, y: (py - oy) / scale }),
  };
}

function averageEdgeLength(graph) {
  if (graph._avgEdge) return graph._avgEdge;
  let s = 0, c = 0;
  for (const e of graph.edges) { s += e.cost; c++; }
  graph._avgEdge = c ? s / c : 1;
  return graph._avgEdge;
}

// ---------------------------------------------------------------------------
// 정적 지도 (도로·강·지역명) — 크기별로 캐시
// ---------------------------------------------------------------------------
const staticCache = new WeakMap();

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** rect 크기의 정적 지도 이미지를 반환 (캐시) */
export function getStaticLayer(graph, rect, options = {}) {
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  const key = `${w}x${h}:${options.labels !== false}`;
  let perGraph = staticCache.get(graph);
  if (!perGraph) { perGraph = new Map(); staticCache.set(graph, perGraph); }
  if (perGraph.has(key)) return perGraph.get(key);
  if (perGraph.size > 8) perGraph.clear();

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const vp = makeViewport(graph.bounds, { x: 0, y: 0, w, h });
  drawStaticMap(ctx, graph, vp, options);
  perGraph.set(key, canvas);
  return canvas;
}

export function drawStaticMap(ctx, graph, vp, { labels = true } = {}) {
  const { rect, ui } = vp;
  const g = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  g.addColorStop(0, THEME.bgGrad);
  g.addColorStop(1, THEME.bg);
  ctx.fillStyle = g;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  // 강 (가상 지도: river 하나 / 실제 지도: OSM에서 받은 강 중심선 여러 개)
  const waterLines = graph.river ? [graph.river.points] : graph.waterLines || [];
  if (waterLines.length) {
    const riverW = (graph.river ? graph.river.width : graph.waterWidth || 0.6) * vp.scale;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const pts of waterLines) {
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(vp.sx(x), vp.sy(y)) : ctx.moveTo(vp.sx(x), vp.sy(y))));
    }
    ctx.strokeStyle = THEME.riverGlow;
    ctx.lineWidth = riverW * 1.9;
    ctx.stroke();
    ctx.strokeStyle = THEME.river;
    ctx.lineWidth = riverW;
    ctx.stroke();
    ctx.restore();
  }

  // 산·공사 구역
  for (const o of graph.obstacles || []) {
    ctx.beginPath();
    ctx.arc(vp.sx(o.x), vp.sy(o.y), o.r * vp.scale, 0, Math.PI * 2);
    if (o.kind === 'construction') {
      ctx.fillStyle = THEME.construction;
      ctx.fill();
      ctx.setLineDash([6 * ui, 5 * ui]);
      ctx.strokeStyle = 'rgba(255, 160, 60, 0.7)';
      ctx.lineWidth = 1.5 * ui;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = THEME.mountain;
      ctx.fill();
    }
  }

  // 지역명
  if (labels) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(13 * ui)}px ${FONT}`;
    ctx.fillStyle = THEME.district;
    for (const d of graph.districts || []) ctx.fillText(d.name, vp.sx(d.x), vp.sy(d.y));
  }

  // 도로 (실제 도로망은 등급별 굵기: 고속·간선은 굵고 밝게)
  ctx.lineCap = 'round';
  const dense = isDense(graph);
  const passes = dense
    ? [
      { test: (e) => !MAJOR_ROADS.has(e.road), color: 'rgba(120, 140, 200, 0.22)', width: 0.9 },
      { test: (e) => MAJOR_ROADS.has(e.road), color: THEME.roadMajor, width: 1.6 },
    ]
    : [{ test: () => true, color: THEME.road, width: 2 }];
  for (const p of passes) {
    ctx.beginPath();
    for (const e of graph.edges) {
      if (e.blocked || e.bridge || !p.test(e)) continue;
      const a = graph.nodes[e.from], b = graph.nodes[e.to];
      ctx.moveTo(vp.sx(a.x), vp.sy(a.y));
      ctx.lineTo(vp.sx(b.x), vp.sy(b.y));
    }
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(0.8, p.width * ui);
    ctx.stroke();
  }

  // 다리
  ctx.beginPath();
  for (const e of graph.edges) {
    if (!e.bridge || e.blocked) continue;
    const a = graph.nodes[e.from], b = graph.nodes[e.to];
    ctx.moveTo(vp.sx(a.x), vp.sy(a.y));
    ctx.lineTo(vp.sx(b.x), vp.sy(b.y));
  }
  ctx.strokeStyle = THEME.bridge;
  ctx.lineWidth = Math.max(1.5, 3 * ui);
  ctx.stroke();

  // 막힌 도로 (빨간 점선 + X)
  ctx.save();
  ctx.setLineDash([4 * ui, 4 * ui]);
  ctx.strokeStyle = THEME.blocked;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = Math.max(1, 1.8 * ui);
  ctx.beginPath();
  for (const e of graph.edges) {
    if (!e.blocked) continue;
    const a = graph.nodes[e.from], b = graph.nodes[e.to];
    ctx.moveTo(vp.sx(a.x), vp.sy(a.y));
    ctx.lineTo(vp.sx(b.x), vp.sy(b.y));
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const xs = (dense ? 2.2 : 3.5) * ui;
  ctx.lineWidth = Math.max(1.2, 2.2 * ui);
  ctx.beginPath();
  for (const e of graph.edges) {
    if (!e.blocked) continue;
    const a = graph.nodes[e.from], b = graph.nodes[e.to];
    const mx = (vp.sx(a.x) + vp.sx(b.x)) / 2, my = (vp.sy(a.y) + vp.sy(b.y)) / 2;
    ctx.moveTo(mx - xs, my - xs); ctx.lineTo(mx + xs, my + xs);
    ctx.moveTo(mx + xs, my - xs); ctx.lineTo(mx - xs, my + xs);
  }
  ctx.stroke();
  ctx.restore();

  // 교차로 점 (교차로가 아주 많은 실제 도로망에서는 생략)
  if (!dense) {
    ctx.fillStyle = 'rgba(170, 185, 255, 0.35)';
    const r = Math.max(0.8, 1.6 * ui);
    for (const n of graph.nodes) ctx.fillRect(vp.sx(n.x) - r / 2, vp.sy(n.y) - r / 2, r, r);
  }
}

const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary']);

/** 교차로가 많은 지도(실제 도로망)인지 — 점·선 크기를 줄이는 데 사용 */
function isDense(graph) {
  return graph.nodes.length > 2500;
}

/** 지도 데이터 출처 표시 (실제 도로망일 때 지도 오른쪽 아래) */
function drawAttribution(ctx, graph, rect) {
  const text = graph.meta?.attribution;
  if (!text) return;
  const ui = rect.w / 640;
  const size = Math.max(10, Math.round(11 * ui));
  ctx.font = `600 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + size;
  const h = size * 1.6;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(rect.x + rect.w - w, rect.y + rect.h - h, w, h);
  ctx.fillStyle = 'rgba(230, 235, 255, 0.9)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rect.x + rect.w - size / 2, rect.y + rect.h - h / 2);
}

// ---------------------------------------------------------------------------
// 탐색 과정·경로·출발/도착 표시
// ---------------------------------------------------------------------------
/**
 * @param view { shown, pathProgress }  viewAtStep() 결과
 */
export function drawSearch(ctx, graph, vp, result, view, style) {
  const { ui } = vp;
  const order = result.expandedOrder;
  const parents = result.expandedParent;
  const shown = view.shown;
  const thin = isDense(graph) ? 0.5 : 1; // 실제 도로망처럼 촘촘한 지도에서는 선·점을 가늘게
  if (shown > 0) {
    // 1) 탐색 영역(반투명 면)
    const rad = averageEdgeLength(graph) * 0.62 * vp.scale;
    ctx.beginPath();
    for (let k = 0; k < shown; k++) {
      const n = graph.nodes[order[k]];
      const x = vp.sx(n.x), y = vp.sy(n.y);
      ctx.moveTo(x + rad, y);
      ctx.arc(x, y, rad, 0, Math.PI * 2);
    }
    ctx.fillStyle = style.soft;
    ctx.fill();

    // 2) 탐색 트리(부모 → 노드)
    ctx.beginPath();
    for (let k = 0; k < shown; k++) {
      const p = parents[k];
      if (p < 0) continue;
      const a = graph.nodes[p], b = graph.nodes[order[k]];
      ctx.moveTo(vp.sx(a.x), vp.sy(a.y));
      ctx.lineTo(vp.sx(b.x), vp.sy(b.y));
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = style.color;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 6 * ui * thin;
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(1, 2 * ui * thin);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 3) 확장한 노드 점
    ctx.fillStyle = style.color;
    const r = Math.max(0.8, 2.6 * ui * thin);
    ctx.beginPath();
    for (let k = 0; k < shown; k++) {
      const n = graph.nodes[order[k]];
      ctx.moveTo(vp.sx(n.x) + r, vp.sy(n.y));
      ctx.arc(vp.sx(n.x), vp.sy(n.y), r, 0, Math.PI * 2);
    }
    ctx.fill();

    // 4) 최근에 확장한 노드(탐색 머리) 강조
    if (!view.done) {
      const head = Math.max(0, shown - 6);
      for (let k = head; k < shown; k++) {
        const n = graph.nodes[order[k]];
        const a = (k - head + 1) / (shown - head);
        ctx.beginPath();
        ctx.arc(vp.sx(n.x), vp.sy(n.y), (4 + 5 * a) * ui, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.25 + 0.6 * a;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  if (view.pathProgress > 0 && result.reached) drawPath(ctx, graph, vp, result.path, view.pathProgress);
}

export function drawPath(ctx, graph, vp, path, progress) {
  if (path.length < 2) return;
  const pts = path.map((id) => [vp.sx(graph.nodes[id].x), vp.sy(graph.nodes[id].y)]);
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let remain = total * progress;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  let tip = pts[0];
  for (let i = 1; i < pts.length && remain > 0; i++) {
    const t = Math.min(1, remain / seg[i - 1]);
    tip = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    ctx.lineTo(tip[0], tip[1]);
    remain -= seg[i - 1];
  }
  const { ui } = vp;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = THEME.path;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 16 * ui;
  ctx.stroke();
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 9 * ui;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4 * ui;
  ctx.stroke();
  if (progress < 1) {
    ctx.beginPath();
    ctx.arc(tip[0], tip[1], 7 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
}

/** 출발(빨강)·도착(금색) 표시. time(초)은 깜빡임 효과용. */
export function drawMarkers(ctx, graph, vp, start, goal, time = 0, names = {}) {
  const { ui } = vp;
  const mark = (id, color, label, phase) => {
    const n = graph.nodes[id];
    if (!n) return;
    const x = vp.sx(n.x), y = vp.sy(n.y);
    const pulse = (Math.sin(time * 4 + phase) + 1) / 2;
    ctx.beginPath();
    ctx.arc(x, y, (13 + 8 * pulse) * ui, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35 + 0.3 * (1 - pulse);
    ctx.lineWidth = 3 * ui;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, 9 * ui, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5 * ui;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    if (label) {
      ctx.font = `800 ${Math.round(15 * ui)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const ty = y - 16 * ui;
      ctx.lineWidth = 4 * ui;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(label, x, ty);
      ctx.fillStyle = color;
      ctx.fillText(label, x, ty);
    }
  };
  mark(start, THEME.start, names.start, 0);
  mark(goal, THEME.goal, names.goal, Math.PI);
}

/** 한 패널 전체(정적 지도 + 탐색 + 표시)를 그린다. */
export function drawPanel(ctx, graph, rect, opts) {
  const { result, view, algo, start, goal, time = 0, names } = opts;
  const layer = getStaticLayer(graph, rect, { labels: opts.labels });
  ctx.drawImage(layer, rect.x, rect.y, rect.w, rect.h);
  const vp = makeViewport(graph.bounds, rect);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  if (result && view) drawSearch(ctx, graph, vp, result, view, ALGO_STYLE[algo]);
  if (start >= 0 && goal >= 0) drawMarkers(ctx, graph, vp, start, goal, time, names);
  drawAttribution(ctx, graph, rect);
  ctx.restore();
  return vp;
}

/** 네온 글자 */
export function neonText(ctx, text, x, y, { size, color, weight = 900, align = 'center', baseline = 'middle', glow = 18 }) {
  ctx.save();
  ctx.font = `${weight} ${Math.round(size)}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.shadowColor = color;
  ctx.shadowBlur = glow;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.globalAlpha = 0.55;
  ctx.fillText(text, x, y);
  ctx.restore();
}
