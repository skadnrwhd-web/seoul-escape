// recorder.js — 쇼츠(1080×1920) 영상의 한 프레임을 그린다.
// 프레임 번호만으로 화면이 결정되는 결정론적 방식이라, 화면 녹화처럼 프레임이 빠지거나
// 사용자 조작으로 결과가 바뀌는 일이 없다. 수치는 모두 실제 계산 결과(scene.race)를 쓴다.

import { THEME, FONT, ALGO_STYLE, drawPanel, viewAtStep, neonText } from './animation.js';
import { formatDistance, formatMs } from './metrics.js';

/** 영상 장면 정보 만들기 */
export function createScene({ graph, race, start, goal, names, compare, settings }) {
  const v = settings.video;
  const segments = {
    intro: Math.max(0, v.introSeconds),
    search: Math.max(1, v.searchSeconds),
    path: Math.max(0, v.pathSeconds),
    stats: Math.max(0, v.statsSeconds),
  };
  const duration = segments.intro + segments.search + segments.path + segments.stats;
  return {
    graph,
    race,
    start,
    goal,
    names,
    compare,
    title: settings.title,
    subtitle: settings.subtitle,
    width: v.width,
    height: v.height,
    fps: v.fps,
    segments,
    duration,
    totalFrames: Math.round(duration * v.fps),
    unitLabel: graph.meta.unitLabel || 'km',
    disclaimer: graph.meta.isReal
      ? `지도 데이터 ${graph.meta.attribution} (${graph.meta.license})`
      : graph.meta.disclaimer || '가상 지도',
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/** 레이아웃: 위아래로 두 지도 패널 (1080 폭 기준 좌표를 실제 크기로 환산) */
function layout(scene) {
  const k = scene.width / 1080;
  // 지도 비율에 맞춰 1040×650 상자 안에 들어가게 (가상 지도 24:15는 꽉 차고, 정사각형에 가까운 서울은 가운데 정렬)
  const b = scene.graph.bounds;
  const aspect = (b.maxY - b.minY) / (b.maxX - b.minX);
  let mapW = 1040 * k;
  let mapH = Math.round(mapW * aspect);
  if (mapH > 650 * k) { mapH = Math.round(650 * k); mapW = mapH / aspect; }
  const x = (scene.width - mapW) / 2;
  const top1 = 355 * k;
  const top2 = top1 + mapH + 90 * k;
  return {
    k,
    panels: {
      dijkstra: { label: top1 - 62 * k, rect: { x, y: top1, w: mapW, h: mapH } },
      astar: { label: top2 - 62 * k, rect: { x, y: top2, w: mapW, h: mapH } },
    },
    footer: top2 + mapH + 20 * k,
  };
}

/** 시간 t(초)에서의 각 알고리즘 표시 상태 */
export function sceneStateAt(scene, t) {
  const s = scene.segments;
  const tSearch = s.intro, tPath = s.intro + s.search, tStats = tPath + s.path;
  const counts = {
    dijkstra: scene.race.dijkstra.result.expandedOrder.length,
    astar: scene.race.astar.result.expandedOrder.length,
  };
  const maxSteps = Math.max(counts.dijkstra, counts.astar);
  let phase, step, pathProgress = 0;
  if (t < tSearch) { phase = 'intro'; step = 0; }
  else if (t < tPath) { phase = 'search'; step = ((t - tSearch) / s.search) * maxSteps; }
  else {
    phase = t < tStats ? 'path' : 'stats';
    step = maxSteps;
    pathProgress = s.path > 0 ? easeOut(clamp01((t - tPath) / Math.min(2.5, s.path * 0.6))) : 1;
  }
  const views = {};
  for (const algo of ['dijkstra', 'astar']) {
    const v = viewAtStep(counts[algo], step, Infinity);
    views[algo] = { ...v, pathProgress: phase === 'path' || phase === 'stats' ? pathProgress : 0 };
  }
  return { phase, step, maxSteps, views, tSearch, tPath, tStats };
}

/** frameIndex번째 프레임을 ctx(scene.width × scene.height)에 그린다. */
export function renderShortsFrame(ctx, frameIndex, scene) {
  const t = frameIndex / scene.fps;
  const W = scene.width, H = scene.height;
  const L = layout(scene);
  const k = L.k;
  const st = sceneStateAt(scene, t);

  // 배경
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0b0620');
  bg.addColorStop(0.5, '#060a1c');
  bg.addColorStop(1, '#03040c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 머리글
  neonText(ctx, scene.title, W / 2, 92 * k, { size: 96 * k, color: THEME.pink, glow: 30 * k });
  neonText(ctx, scene.subtitle, W / 2, 178 * k, { size: 52 * k, color: THEME.cyan, glow: 18 * k, weight: 800 });
  ctx.font = `700 ${Math.round(38 * k)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = THEME.text;
  ctx.fillText(`${scene.names.start}  →  ${scene.names.goal}`, W / 2, 242 * k);

  // 두 패널
  for (const algo of ['dijkstra', 'astar']) {
    const P = L.panels[algo];
    const style = ALGO_STYLE[algo];
    const m = scene.race[algo];
    const view = st.views[algo];
    drawPanel(ctx, scene.graph, P.rect, {
      result: m.result,
      view,
      algo,
      start: scene.start,
      goal: scene.goal,
      time: t,
      names: {},
    });
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 3 * k;
    ctx.globalAlpha = 0.8;
    ctx.strokeRect(P.rect.x, P.rect.y, P.rect.w, P.rect.h);
    ctx.globalAlpha = 1;

    // 라벨 줄
    const ly = P.label + 30 * k;
    neonText(ctx, style.label, P.rect.x + 6 * k, ly, { size: 50 * k, color: style.color, align: 'left', glow: 16 * k });
    const shown = view.shown;
    let right;
    if (st.phase === 'intro') right = 'READY';
    else if (view.pathProgress > 0) right = `경로 ${formatDistance(m.pathLength, 'km')}`;
    else right = `탐색 ${shown.toLocaleString()} 노드`;
    ctx.font = `800 ${Math.round(40 * k)}px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = THEME.text;
    ctx.fillText(right, P.rect.x + P.rect.w - 6 * k, ly);

    if (st.phase === 'search' && view.done) {
      drawBadge(ctx, m.reached ? '도착!' : '도달 불가', P.rect.x + P.rect.w - 20 * k, P.rect.y + 20 * k, k, m.reached ? THEME.goal : THEME.blocked);
    }
  }

  // 하단 안내
  ctx.font = `700 ${Math.round(34 * k)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = THEME.textDim;
  let footer = '';
  if (st.phase === 'intro') footer = '같은 지도 · 같은 출발점 · 같은 목적지';
  else if (st.phase === 'search') footer = '탐색 중… 먼저 목적지에 닿는 쪽은?';
  else footer = scene.compare.path;
  ctx.fillText(footer, W / 2, L.footer + 40 * k);
  ctx.font = `500 ${Math.round(24 * k)}px ${FONT}`;
  ctx.fillStyle = 'rgba(154,163,208,0.7)';
  ctx.fillText(`${scene.disclaimer} · 수치는 실제 계산 결과`, W / 2, H - 46 * k);

  // 진행 막대
  const prog = clamp01(t / scene.duration);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, H - 8 * k, W, 8 * k);
  ctx.fillStyle = THEME.pink;
  ctx.fillRect(0, H - 8 * k, W * prog, 8 * k);

  if (st.phase === 'intro') drawIntroOverlay(ctx, scene, t, k);
  if (st.phase === 'stats') drawStatsOverlay(ctx, scene, t - st.tStats, k);
}

function drawBadge(ctx, text, rightX, topY, k, color) {
  ctx.font = `900 ${Math.round(40 * k)}px ${FONT}`;
  const w = ctx.measureText(text).width + 44 * k;
  const h = 66 * k;
  const x = rightX - w;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  roundRect(ctx, x, topY, w, h, 16 * k);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * k;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, topY + h / 2 + 2 * k);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawIntroOverlay(ctx, scene, t, k) {
  const W = scene.width, H = scene.height;
  const dur = scene.segments.intro || 1;
  const fadeOut = clamp01((dur - t) / 0.35);
  ctx.save();
  ctx.globalAlpha = 0.72 * fadeOut;
  ctx.fillStyle = '#04030c';
  ctx.fillRect(0, 300 * k, W, H - 300 * k);
  ctx.globalAlpha = fadeOut;
  const goTime = dur - 0.7;
  if (t < goTime) {
    const s = easeOut(clamp01(t / 0.6));
    neonText(ctx, 'DIJKSTRA', W / 2 - (1 - s) * 400 * k, 820 * k, { size: 120 * k, color: THEME.dijkstra, glow: 34 * k });
    neonText(ctx, 'VS', W / 2, 990 * k, { size: 150 * k * (0.6 + 0.4 * s), color: THEME.pink, glow: 40 * k });
    neonText(ctx, 'A*', W / 2 + (1 - s) * 400 * k, 1170 * k, { size: 160 * k, color: THEME.astar, glow: 34 * k });
    ctx.font = `700 ${Math.round(40 * k)}px ${FONT}`;
    ctx.fillStyle = THEME.text;
    ctx.textAlign = 'center';
    ctx.fillText('누가 먼저 목적지에 도착할까?', W / 2, 1340 * k);
  } else {
    const s = clamp01((t - goTime) / 0.3);
    neonText(ctx, 'GO!', W / 2, 990 * k, { size: 220 * k * (0.7 + 0.3 * s), color: THEME.goal, glow: 50 * k });
  }
  ctx.restore();
}

function drawStatsOverlay(ctx, scene, tLocal, k) {
  const W = scene.width;
  const a = easeOut(clamp01(tLocal / 0.45));
  const d = scene.race.dijkstra, s = scene.race.astar;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(3, 3, 14, 0.82)';
  ctx.fillRect(0, 280 * k, W, 1500 * k);

  const cardX = 60 * k, cardW = W - 120 * k, cardY = 430 * k, cardH = 1150 * k;
  ctx.fillStyle = 'rgba(16, 18, 48, 0.95)';
  roundRect(ctx, cardX, cardY, cardW, cardH, 36 * k);
  ctx.fill();
  ctx.strokeStyle = THEME.pink;
  ctx.lineWidth = 4 * k;
  ctx.stroke();

  const headColor = scene.compare.headline.startsWith('A*') ? THEME.astar : scene.compare.headline.startsWith('DIJ') ? THEME.dijkstra : THEME.goal;
  neonText(ctx, scene.compare.headline, W / 2, cardY + 110 * k, { size: 104 * k, color: headColor, glow: 36 * k });

  const colD = cardX + cardW * 0.56, colA = cardX + cardW * 0.85;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.round(44 * k)}px ${FONT}`;
  ctx.fillStyle = THEME.dijkstra;
  ctx.fillText('DIJKSTRA', colD, cardY + 250 * k);
  ctx.fillStyle = THEME.astar;
  ctx.fillText('A*', colA, cardY + 250 * k);

  const rows = [
    ['탐색 노드', d.expandedCount.toLocaleString(), s.expandedCount.toLocaleString()],
    ['경로 길이', formatDistance(d.pathLength, 'km'), formatDistance(s.pathLength, 'km')],
    ['계산 시간', formatMs(d.timeMs), formatMs(s.timeMs)],
  ];
  rows.forEach((row, i) => {
    const y = cardY + (370 + i * 150) * k;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(cardX + 30 * k, y - 60 * k, cardW - 60 * k, 120 * k);
    ctx.textAlign = 'left';
    ctx.font = `800 ${Math.round(42 * k)}px ${FONT}`;
    ctx.fillStyle = THEME.textDim;
    ctx.fillText(row[0], cardX + 60 * k, y);
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(46 * k)}px ${FONT}`;
    ctx.fillStyle = THEME.text;
    ctx.fillText(row[1], colD, y);
    ctx.fillText(row[2], colA, y);
  });

  ctx.textAlign = 'center';
  ctx.font = `700 ${Math.round(36 * k)}px ${FONT}`;
  ctx.fillStyle = THEME.goal;
  ctx.fillText(scene.compare.nodes, W / 2, cardY + 870 * k);
  ctx.fillStyle = THEME.text;
  ctx.fillText(scene.compare.path, W / 2, cardY + 930 * k);
  ctx.font = `600 ${Math.round(30 * k)}px ${FONT}`;
  ctx.fillStyle = THEME.textDim;
  ctx.fillText(scene.compare.time, W / 2, cardY + 990 * k);
  ctx.font = `500 ${Math.round(26 * k)}px ${FONT}`;
  ctx.fillText(`계산 시간: 이 기기에서 ${d.timingRuns}회 반복 실행한 평균 (그리기 시간 제외)`, W / 2, cardY + 1050 * k);
  ctx.restore();
}
