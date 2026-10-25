// app.js — 게임 화면 연결 (버튼, 지도 클릭, 재생 루프, 영상 만들기).

import { generateCity, buildGraph, nearestNode, describeNode, prepareRealNetwork } from './map.js';
import { runRace, compareMetrics, formatDistance, formatMs } from './metrics.js';
import { RaceController, drawPanel, makeViewport } from './animation.js';
import { createScene } from './recorder.js';
import { checkServer, exportMp4, exportWithMediaRecorder } from './export.js';

const $ = (id) => document.getElementById(id);
const ALGOS = ['dijkstra', 'astar'];

const state = {
  config: null, // 가상 지도 설정 (data/sample-map.json)
  realData: null, // 실제 도로망 (data/real-map.json, 처음 선택할 때 불러옴)
  realAvailable: false,
  mapMode: 'virtual', // 'virtual' | 'real'
  settings: null,
  difficulty: 'normal',
  obstacleSeed: 1,
  graph: null,
  startPos: null, // { x, y } — 난이도/장애물이 바뀌어도 위치를 유지하기 위해 좌표로 저장
  goalPos: null,
  start: -1,
  goal: -1,
  race: null,
  compare: null,
  picking: null, // 'start' | 'goal' | null
  busy: false, // 영상 제작 중
  controller: null,
  canvases: {},
};

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------
async function init() {
  try {
    const [config, settings] = await Promise.all([
      fetchJson('data/sample-map.json'),
      fetchJson('data/game-settings.json'),
    ]);
    state.config = config;
    state.settings = settings;
    state.difficulty = settings.game?.defaultDifficulty || 'normal';
    state.controller = new RaceController({ stepsPerSecond: settings.game?.stepsPerSecond || 60 });

    $('gameTitle').textContent = settings.title;
    $('gameSubtitle').textContent = settings.subtitle;
    document.title = `${settings.title}: ${settings.subtitle}`;

    state.realAvailable = await fileExists('data/real-map.json');
    fillMapSelect();
    fillSelects();
    const sc = config.scenarios[settings.game?.defaultScenario || 0] || config.scenarios[0];
    applyScenario(sc, false);
    rebuild();
    bindEvents();
    setupCanvases();
    requestAnimationFrame(loop);
  } catch (err) {
    showMessage(`게임을 불러오지 못했습니다: ${err.message}. 'npm start'로 서버를 실행한 뒤 http://localhost:8765 으로 접속했는지 확인하세요.`);
    console.error(err);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} 파일을 읽을 수 없습니다 (${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} 파일 형식(JSON)이 올바르지 않습니다. 쉼표·따옴표를 확인하세요`);
  }
}

async function fileExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** 현재 지도 모드의 설정 (장소·경로·난이도 목록) */
function mapData() {
  return state.mapMode === 'real' ? state.realData : state.config;
}

function fillMapSelect() {
  const sel = $('selMap');
  sel.innerHTML = '';
  sel.add(new Option('가상 서울', 'virtual'));
  const real = new Option(state.realAvailable ? '실제 서울 (OSM)' : '실제 서울 (OSM) — 데이터 없음', 'real');
  real.disabled = !state.realAvailable;
  sel.add(real);
  sel.value = state.mapMode;
}

function fillSelects() {
  const data = mapData();
  const sel = $('selScenario');
  sel.innerHTML = '';
  data.scenarios.forEach((s, i) => sel.add(new Option(s.name, String(i))));
  sel.add(new Option('직접 지정', 'custom'));
  const dSel = $('selDifficulty');
  dSel.innerHTML = '';
  for (const [key, d] of Object.entries(data.difficulties)) dSel.add(new Option(d.label, key));
  if (!data.difficulties[state.difficulty]) state.difficulty = Object.keys(data.difficulties)[0];
  dSel.value = state.difficulty;
}

/** 지도 모드 전환 (가상 ↔ 실제). 실제 도로망은 처음 고를 때 한 번만 불러온다. */
async function switchMap(mode) {
  if (state.busy || mode === state.mapMode) return;
  const prevScenario = $('selScenario').value;
  if (mode === 'real' && !state.realData) {
    showMessage('실제 서울 도로망을 불러오는 중… (약 2.5MB)', 'info');
    try {
      const data = await fetchJson('data/real-map.json');
      if (!data.meta?.isReal || !Array.isArray(data.nodes)) throw new Error('real-map.json 형식이 올바르지 않습니다');
      state.realData = data;
    } catch (err) {
      $('selMap').value = state.mapMode;
      showMessage(`실제 도로망을 불러오지 못했습니다: ${err.message}. 터미널에서 'npm run fetch-map'을 실행해 주세요. 가상 지도로 계속합니다.`);
      return;
    }
  }
  // 이전 지도의 결과를 먼저 지운 뒤 지도를 바꾼다 (이전 결과가 새 지도에 섞이지 않게)
  setPicking(null);
  state.race = null;
  state.controller.clear();
  state.mapMode = mode;
  state.graph = null;
  fillSelects();
  const data = mapData();
  const idx = prevScenario === 'custom' ? 0 : Math.min(Number(prevScenario) || 0, data.scenarios.length - 1);
  $('selScenario').value = String(idx);
  applyScenario(data.scenarios[idx], false);
  rebuild();
  resizeCanvases();
}

function placeById(id) {
  const p = mapData().places.find((pl) => pl.id === id);
  if (!p) throw new Error(`장소를 찾을 수 없습니다: ${id}`);
  return p;
}

function applyScenario(sc, recompute = true) {
  const s = placeById(sc.start), g = placeById(sc.goal);
  state.startPos = { x: s.x, y: s.y };
  state.goalPos = { x: g.x, y: g.y };
  if (recompute) rebuild({ keepGraph: true });
}

// ---------------------------------------------------------------------------
// 지도·경주 다시 계산 (이전 결과는 완전히 버린다)
// ---------------------------------------------------------------------------
function rebuild({ keepGraph = false } = {}) {
  hideMessage();
  try {
    if (!keepGraph || !state.graph) {
      const opts = { difficulty: state.difficulty, obstacleSeed: state.obstacleSeed };
      const raw = state.mapMode === 'real'
        ? prepareRealNetwork(state.realData, opts)
        : generateCity(state.config, opts);
      state.graph = buildGraph(raw);
      updateDisclaimer();
    }
    const graph = state.graph;
    state.start = nearestNode(graph, state.startPos.x, state.startPos.y);
    state.goal = nearestNode(graph, state.goalPos.x, state.goalPos.y);
    if (state.start < 0 || state.goal < 0) throw new Error('지도에 교차로가 없습니다.');
    if (state.start === state.goal) {
      state.race = null;
      state.controller.clear();
      updateUi();
      showMessage('출발점과 목적지가 같은 교차로입니다. 서로 떨어진 곳을 선택해 주세요.');
      return;
    }
    // 계산은 여기서 한 번만. 애니메이션은 이 기록을 재생만 한다.
    state.race = runRace(graph, state.start, state.goal);
    state.compare = compareMetrics(state.race.dijkstra, state.race.astar);
    state.controller.load(state.race);
    if (!state.race.dijkstra.reached) showMessage('목적지에 도달할 수 있는 도로가 없습니다. 장애물을 재배치하거나 다른 목적지를 골라 보세요.');
  } catch (err) {
    state.race = null;
    state.controller.clear();
    showMessage(`경로 계산 중 문제가 생겼습니다: ${err.message}`);
    console.error(err);
  }
  updateUi();
}

function names() {
  return {
    start: describeNode(state.graph, state.start),
    goal: describeNode(state.graph, state.goal),
  };
}

// ---------------------------------------------------------------------------
// 화면 갱신
// ---------------------------------------------------------------------------
function updateUi() {
  const c = state.controller;
  const st = c.state;
  const has = !!state.race;
  const busy = state.busy;
  $('btnStart').disabled = busy || !has || !(st === 'ready' || st === 'finished');
  $('btnStart').textContent = st === 'finished' ? '▶ 다시 시작' : '▶ 시작';
  $('btnPause').disabled = busy || st !== 'running';
  $('btnResume').disabled = busy || st !== 'paused';
  $('btnRestart').disabled = busy || !has;
  $('btnSkip').disabled = busy || !has || st === 'finished';
  $('btnVideo').disabled = busy || !has || !state.race.dijkstra.reached;
  for (const id of ['selMap', 'selScenario', 'selDifficulty', 'btnObstacles', 'btnPickStart', 'btnPickGoal']) $(id).disabled = busy;

  $('btnPickStart').classList.toggle('active', state.picking === 'start');
  $('btnPickGoal').classList.toggle('active', state.picking === 'goal');
  document.body.classList.toggle('picking', !!state.picking);

  if (state.graph && state.start >= 0) {
    const n = names();
    $('missionText').textContent = `${n.start} → ${n.goal}`;
  }
  updateStats();
}

function updateStats() {
  const c = state.controller;
  const finished = c.state === 'finished';
  for (const algo of ALGOS) {
    const m = state.race?.[algo];
    const v = m && c.state !== 'empty' ? c.view(algo) : null;
    const started = v && (c.step > 0 || finished);
    const done = v && v.done && started;
    $(`live-${algo}`).textContent = !m ? '-' : !started ? '대기' : done ? (m.reached ? '도착 ✓' : '도달 불가') : `탐색 중 ${v.shown}`;
    $(`nodes-${algo}`).textContent = !started ? '-' : v.shown.toLocaleString();
    $(`len-${algo}`).textContent = done ? formatDistance(m.pathLength, 'km') : '-';
    $(`time-${algo}`).textContent = done ? formatMs(m.timeMs) : '-';
    $(`arrive-${algo}`).hidden = !(done && m.reached);
  }
  const res = $('result');
  if (finished && state.race) {
    res.hidden = false;
    $('resultHeadline').textContent = state.compare.headline;
    $('resultNodes').textContent = state.compare.nodes;
    $('resultPath').textContent = state.compare.path;
    $('resultTime').textContent = state.compare.time;
    $('resultNote').textContent = `실행 시간: 이 기기에서 각 알고리즘을 ${state.race.dijkstra.timingRuns}회 반복 실행한 평균 (애니메이션·그리기 시간 제외). 거리 단위는 ${state.graph.meta.unitLabel}.`;
  } else {
    res.hidden = true;
  }
}

let lastStatsKey = '';
function loop(ts) {
  const dt = loop.last ? Math.min(0.1, (ts - loop.last) / 1000) : 0;
  loop.last = ts;
  const changed = state.controller.tick(dt);
  draw(ts / 1000);
  const key = `${state.controller.state}:${Math.floor(state.controller.step)}`;
  if (changed || key !== lastStatsKey) {
    lastStatsKey = key;
    if (changed) updateUi();
    else updateStats();
  }
  requestAnimationFrame(loop);
}

function draw(time) {
  if (!state.graph) return;
  const c = state.controller;
  for (const algo of ALGOS) {
    const canvas = state.canvases[algo];
    if (!canvas || !canvas.width) continue;
    const ctx = canvas.getContext('2d');
    const rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const showSearch = state.race && c.state !== 'empty' && c.state !== 'ready';
    drawPanel(ctx, state.graph, rect, {
      result: showSearch ? state.race[algo].result : null,
      view: showSearch ? c.view(algo) : null,
      algo,
      start: state.start,
      goal: state.goal,
      time,
      names: { start: '출발', goal: '도착' },
    });
  }
}

// ---------------------------------------------------------------------------
// 캔버스 크기 (반응형 + 고해상도 화면)
// ---------------------------------------------------------------------------
function setupCanvases() {
  for (const algo of ALGOS) state.canvases[algo] = $(`canvas-${algo}`);
  new ResizeObserver(resizeCanvases).observe($('canvas-dijkstra').parentElement);
  resizeCanvases();
}

/** 지도 비율(가상 24:15, 실제 서울은 정사각형에 가까움)에 맞춰 캔버스 크기 조정 */
function resizeCanvases() {
  if (!state.graph || !state.canvases.dijkstra) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const b = state.graph.bounds;
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  for (const algo of ALGOS) {
    const cv = state.canvases[algo];
    cv.style.aspectRatio = `${bw.toFixed(3)} / ${bh.toFixed(3)}`;
    const w = Math.max(200, Math.round(cv.clientWidth * dpr));
    const h = Math.round((w * bh) / bw);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }
}

/** 화면 아래 지도 안내·출처 표시 */
function updateDisclaimer() {
  const el = $('disclaimer');
  const meta = state.graph?.meta;
  el.textContent = '';
  if (!meta?.isReal) {
    el.textContent = state.config.disclaimer;
    return;
  }
  el.append('실제 서울 도로망 · 지도 데이터 ');
  const a = document.createElement('a');
  a.href = 'https://www.openstreetmap.org/copyright';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = meta.attribution;
  el.append(a, ` (${meta.license}) · 데이터 기준 ${String(meta.downloadedAt || '').slice(0, 10)} · 이동 비용 = 도로 거리(신호·정체 미반영)`);
}

// ---------------------------------------------------------------------------
// 이벤트
// ---------------------------------------------------------------------------
function bindEvents() {
  const c = state.controller;
  $('btnStart').onclick = () => { if (c.start()) updateUi(); };
  $('btnPause').onclick = () => { if (c.pause()) updateUi(); };
  $('btnResume').onclick = () => { if (c.resume()) updateUi(); };
  $('btnRestart').onclick = () => { if (c.restart()) updateUi(); };
  $('btnSkip').onclick = () => { if (c.finish()) updateUi(); };
  $('rngSpeed').oninput = (e) => {
    c.setSpeed(Number(e.target.value));
    $('speedOut').textContent = `${Number(e.target.value).toFixed(2).replace(/0$/, '')}x`;
  };
  $('selScenario').onchange = (e) => {
    if (e.target.value === 'custom') {
      setPicking('start');
      return;
    }
    setPicking(null);
    applyScenario(mapData().scenarios[Number(e.target.value)]);
  };
  $('selDifficulty').onchange = (e) => {
    state.difficulty = e.target.value;
    rebuild();
  };
  $('btnObstacles').onclick = () => {
    state.obstacleSeed++;
    rebuild();
    showMessage(state.mapMode === 'real'
      ? `통제 도로를 새로 배치했습니다 (배치 번호 ${state.obstacleSeed}). 빨간 X는 가상의 공사·통제 구간입니다 (실제 교통 정보 아님).`
      : `장애물을 새로 배치했습니다 (배치 번호 ${state.obstacleSeed}). 주황 점선 원은 공사 구역, 빨간 X는 막힌 도로입니다.`, 'info');
  };
  $('selMap').onchange = (e) => switchMap(e.target.value);
  $('btnPickStart').onclick = () => setPicking(state.picking === 'start' ? null : 'start');
  $('btnPickGoal').onclick = () => setPicking(state.picking === 'goal' ? null : 'goal');

  for (const algo of ALGOS) {
    $(`canvas-${algo}`).addEventListener('click', (ev) => onMapClick(ev, algo));
  }
  $('btnVideo').onclick = makeVideo;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.picking) setPicking(null);
  });
}

function setPicking(mode) {
  if (state.busy) return;
  state.picking = mode;
  $('hint').textContent = mode === 'start'
    ? '지도에서 출발점(빨강)으로 쓸 위치를 클릭하세요. (Esc: 취소)'
    : mode === 'goal'
      ? '지도에서 목적지(금색)로 쓸 위치를 클릭하세요. (Esc: 취소)'
      : '출발점·목적지를 바꾸려면 "출발점 지정" 또는 "목적지 지정"을 누른 뒤 지도를 클릭하세요.';
  updateUi();
}

function onMapClick(ev, algo) {
  if (!state.picking || state.busy || !state.graph) return;
  const canvas = state.canvases[algo];
  const r = canvas.getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * canvas.width;
  const py = ((ev.clientY - r.top) / r.height) * canvas.height;
  const vp = makeViewport(state.graph.bounds, { x: 0, y: 0, w: canvas.width, h: canvas.height });
  const w = vp.toWorld(px, py);
  const node = nearestNode(state.graph, w.x, w.y);
  if (node < 0) return;
  const pos = { x: state.graph.nodes[node].x, y: state.graph.nodes[node].y };
  if (state.picking === 'start') {
    state.startPos = pos;
    $('selScenario').value = 'custom';
    setPicking('goal');
  } else {
    state.goalPos = pos;
    $('selScenario').value = 'custom';
    setPicking(null);
  }
  rebuild({ keepGraph: true });
}

// ---------------------------------------------------------------------------
// 영상 만들기
// ---------------------------------------------------------------------------
let videoAbort = null;

async function makeVideo() {
  if (state.busy || !state.race) return;
  if (!state.race.dijkstra.reached) {
    showMessage('목적지에 도달할 수 없는 경주는 영상으로 만들 수 없습니다.');
    return;
  }
  // 지금 결과를 그대로 복사해 사용 (영상 제작 중 조작이 결과를 바꾸지 못함)
  const scene = createScene({
    graph: state.graph,
    race: state.race,
    start: state.start,
    goal: state.goal,
    names: names(),
    compare: state.compare,
    settings: state.settings,
  });
  state.busy = true;
  setPicking(null);
  state.controller.pause();
  updateUi();

  const dlg = $('videoDialog');
  $('videoResult').hidden = true;
  $('btnVideoClose').hidden = true;
  $('btnVideoCancel').hidden = false;
  $('videoProgress').value = 0;
  $('videoStatus').textContent = '로컬 서버와 FFmpeg를 확인하는 중…';
  dlg.showModal();
  videoAbort = new AbortController();
  $('btnVideoCancel').onclick = () => videoAbort?.abort();
  dlg.oncancel = (e) => { e.preventDefault(); videoAbort?.abort(); };

  const onProgress = ({ stage, done, total }) => {
    $('videoProgress').value = done / total;
    const pct = Math.round((done / total) * 100);
    $('videoStatus').textContent =
      stage === 'frames' ? `프레임 만드는 중… ${done} / ${total} (${pct}%)`
        : stage === 'encoding' ? 'MP4 인코딩 마무리 중… 잠시만 기다려 주세요.'
          : `실시간 녹화 중… ${pct}% (영상 길이만큼 걸립니다)`;
  };

  try {
    const env = await checkServer();
    let out;
    if (env.server && env.ffmpeg) {
      out = await exportMp4(scene, { onProgress, signal: videoAbort.signal, quality: state.settings.video.jpegQuality || 0.92 });
      $('videoStatus').textContent = '✅ MP4 영상이 완성되었습니다!';
      $('videoPreview').src = out.url;
      const dur = out.probe?.durationSec ? ` · ${out.probe.durationSec.toFixed(1)}초 · ${out.probe.width}×${out.probe.height}` : '';
      $('videoSaved').textContent = `파일: ${out.fileName}${dur}\n저장 위치: ${out.filePath}`;
      $('videoSaved').style.whiteSpace = 'pre-line';
      $('videoResult').hidden = false;
    } else {
      const reason = env.server
        ? 'FFmpeg가 설치되지 않아 MP4 대신 브라우저 녹화로 저장합니다.'
        : '로컬 서버에 연결되지 않아 브라우저 녹화로 저장합니다.';
      $('videoStatus').textContent = reason;
      out = await exportWithMediaRecorder(scene, { onProgress, signal: videoAbort.signal });
      $('videoStatus').textContent = `✅ 녹화 완료 (${out.format.toUpperCase()})`;
      $('videoSaved').textContent = `파일: ${out.fileName}\n브라우저의 '다운로드' 폴더에 저장되었습니다.${out.format !== 'mp4' ? '\nMP4가 필요하면 FFmpeg를 설치한 뒤 다시 만들어 주세요 (README 참고).' : ''}`;
      $('videoSaved').style.whiteSpace = 'pre-line';
      $('videoResult').hidden = false;
      $('videoPreview').removeAttribute('src');
    }
  } catch (err) {
    $('videoStatus').textContent = err.name === 'AbortError'
      ? '영상 제작을 취소했습니다.'
      : `⚠ 영상을 만들지 못했습니다: ${err.message}`;
    console.error(err);
  } finally {
    videoAbort = null;
    state.busy = false;
    $('btnVideoCancel').hidden = true;
    $('btnVideoClose').hidden = false;
    $('btnVideoClose').onclick = () => { $('videoPreview').pause(); dlg.close(); };
    dlg.oncancel = null;
    updateUi();
  }
}

// ---------------------------------------------------------------------------
// 메시지
// ---------------------------------------------------------------------------
function showMessage(text, kind = 'error') {
  const el = $('message');
  el.textContent = text;
  el.className = `message ${kind === 'info' ? 'info' : ''}`;
  el.hidden = false;
}
function hideMessage() {
  $('message').hidden = true;
}

window.addEventListener('error', (e) => showMessage(`예상하지 못한 오류가 발생했습니다: ${e.message}. 페이지를 새로고침해 주세요.`));

// 테스트·디버깅용 (콘솔에서 상태 확인)
window.__seoulEscape = state;

init();
