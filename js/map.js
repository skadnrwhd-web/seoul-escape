// map.js — 지도(도로 그래프) 모듈.
// 게임 로직과 분리되어 있으며 브라우저와 Node(테스트) 양쪽에서 동작한다.
//
// 지도 데이터는 두 단계로 다룬다.
//   1) "도로망 데이터"(raw): { meta, nodes:[{id,x,y}], edges:[{from,to,cost,oneway,blocked}], 장식 정보 }
//      - generateCity()가 설정 파일(data/sample-map.json)로부터 가상 도시를 만든다.
//      - 실제 도로망(OpenStreetMap 등)도 같은 형식으로 변환하면 그대로 쓸 수 있다.
//   2) "탐색용 그래프"(buildGraph 결과): 인접 리스트, 연결 요소, 휴리스틱 배율 등을 계산해 둔 형태.
// 좌표와 이동 비용은 모두 같은 단위(km)를 사용한다.

// ---------- 결정론적 난수 ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------- 기하 도우미 ----------
export function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function segmentPointDistance(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

// 강 중심선의 y 좌표 (x 위치에서 선형 보간)
export function riverYAt(river, x) {
  const pts = river.points;
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const t = (x - x0) / (x1 - x0 || 1);
      return y0 + t * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

// ---------- 가상 도시 생성 ----------
/**
 * 설정(sample-map.json)으로부터 서울을 모티브로 한 가상 도로망을 만든다.
 * @param {object} config  data/sample-map.json 내용
 * @param {object} options { difficulty: 'easy'|'normal'|'hard', obstacleSeed: number }
 * @returns raw 도로망 데이터 (buildGraph에 넘길 수 있음)
 */
export function generateCity(config, options = {}) {
  const difficulty = options.difficulty || 'normal';
  const diff = config.difficulties[difficulty];
  if (!diff) throw new Error(`알 수 없는 난이도입니다: ${difficulty}`);
  const obstacleSeed = options.obstacleSeed ?? 1;

  const W = config.width, H = config.height;
  const { cols, rows } = diff;
  const margin = 0.45;
  const dx = (W - 2 * margin) / (cols - 1);
  const dy = (H - 2 * margin) / (rows - 1);
  const layoutRng = mulberry32((config.seed ^ hashString(difficulty)) >>> 0);
  const obstacleRng = mulberry32((hashString('obstacles') ^ (obstacleSeed * 2654435761)) >>> 0);
  const river = config.river;
  const riverHalf = river.width / 2 + 0.12;

  // 공사 구역(장애물 시드에 따라 바뀜). 주요 장소는 덮지 않는다.
  const fixedObstacles = (config.obstacles || []).map((o) => ({ ...o, kind: 'mountain' }));
  const construction = [];
  let guard = 0;
  while (construction.length < diff.constructionZones && guard++ < 500) {
    const r = 0.55 + obstacleRng() * 0.6;
    const x = 1 + obstacleRng() * (W - 2);
    const y = 1 + obstacleRng() * (H - 2);
    if (Math.abs(y - riverYAt(river, x)) < riverHalf + r) continue;
    const nearPlace = (config.places || []).some((p) => distance(p.x, p.y, x, y) < r + 0.7);
    const nearOther = [...fixedObstacles, ...construction].some((o) => distance(o.x, o.y, x, y) < o.r + r + 0.3);
    if (nearPlace || nearOther) continue;
    construction.push({ name: '공사 구역', x, y, r, kind: 'construction' });
  }
  const obstacles = [...fixedObstacles, ...construction];

  const side = (x, y) => (y < riverYAt(river, x) ? -1 : 1);
  const insideObstacle = (x, y) => obstacles.some((o) => distance(o.x, o.y, x, y) < o.r);
  const crossesObstacle = (a, b) =>
    obstacles.some((o) => segmentPointDistance(a.x, a.y, b.x, b.y, o.x, o.y) < o.r * 0.85);

  // 1) 교차로 배치 (격자 + 흔들림)
  const grid = []; // grid[i][j] = node | null
  const nodes = [];
  for (let i = 0; i < cols; i++) {
    grid.push([]);
    for (let j = 0; j < rows; j++) {
      const jx = (layoutRng() - 0.5) * 2 * diff.jitter * dx;
      const jy = (layoutRng() - 0.5) * 2 * diff.jitter * dy;
      const x = Math.min(W - 0.1, Math.max(0.1, margin + i * dx + jx));
      const y = Math.min(H - 0.1, Math.max(0.1, margin + j * dy + jy));
      const inRiver = Math.abs(y - riverYAt(river, x)) < riverHalf;
      if (inRiver || insideObstacle(x, y)) {
        grid[i].push(null);
        continue;
      }
      const node = { id: nodes.length, x: round3(x), y: round3(y), i, j };
      nodes.push(node);
      grid[i].push(node);
    }
  }

  // 2) 도로 연결
  const edges = [];
  const edgeSet = new Set();
  const addEdge = (a, b, extra = {}) => {
    const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    const blocked = !extra.bridge && obstacleRng() < diff.blockedRoadChance;
    edges.push({
      from: a.id,
      to: b.id,
      cost: round3(distance(a.x, a.y, b.x, b.y)),
      oneway: false,
      blocked,
      ...extra,
    });
  };
  const tryRoad = (a, b) => {
    if (!a || !b) return;
    if (side(a.x, a.y) !== side(b.x, b.y)) return; // 강을 건너는 길은 다리만 허용
    if (crossesObstacle(a, b)) return;
    if (layoutRng() < diff.missingRoadChance) return;
    addEdge(a, b);
  };

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const n = grid[i][j];
      if (!n) continue;
      if (i + 1 < cols) tryRoad(n, grid[i + 1][j]);
      if (j + 1 < rows) tryRoad(n, grid[i][j + 1]);
      if (i + 1 < cols && j + 1 < rows && layoutRng() < diff.diagonalChance) {
        if (layoutRng() < 0.5) tryRoad(n, grid[i + 1][j + 1]);
        else tryRoad(grid[i + 1][j], grid[i][j + 1]);
      }
    }
  }

  // 3) 다리: 다리 위치에서 가장 가까운 열의 강 북쪽 끝 교차로와 남쪽 끝 교차로를 잇는다.
  const bridges = [];
  for (const b of config.bridges || []) {
    const i = Math.max(0, Math.min(cols - 1, Math.round((b.x - margin) / dx)));
    const column = grid[i].filter(Boolean);
    let north = null, south = null;
    for (const n of column) {
      if (side(n.x, n.y) < 0) north = n;
      else if (!south) south = n;
    }
    if (north && south && distance(north.x, north.y, south.x, south.y) < river.width + 3 * dy) {
      addEdge(north, south, { bridge: b.name });
      bridges.push({ name: b.name, from: north.id, to: south.id });
    }
  }

  return {
    meta: {
      name: config.name,
      disclaimer: config.disclaimer,
      unit: config.unit || 'km',
      unitLabel: config.unitLabel || 'km',
      isReal: false,
      source: '자체 생성 가상 지도',
      license: null,
      difficulty,
      obstacleSeed,
    },
    bounds: { minX: 0, minY: 0, maxX: W, maxY: H },
    nodes: nodes.map(({ id, x, y }) => ({ id, x, y })),
    edges,
    river,
    bridges,
    obstacles,
    districts: config.districts || [],
    places: config.places || [],
    scenarios: config.scenarios || [],
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// ---------- 탐색용 그래프 ----------
/**
 * 도로망 데이터를 탐색용 그래프로 변환한다.
 * - adj[u] = [{ to, cost }]  (막힌 도로 제외, 일방통행 반영)
 * - heuristicScale: A* 휴리스틱(직선거리 × 배율)이 항상 실제 비용 이하가 되도록 하는 배율
 */
export function buildGraph(data) {
  const nodes = data.nodes;
  const n = nodes.length;
  nodes.forEach((node, idx) => {
    if (node.id !== idx) throw new Error('노드 id는 0부터 순서대로 매겨져야 합니다.');
  });
  const adj = Array.from({ length: n }, () => []);
  let minRatio = Infinity;
  for (const e of data.edges) {
    if (e.from < 0 || e.from >= n || e.to < 0 || e.to >= n) throw new Error('도로가 없는 교차로를 가리킵니다.');
    if (!(e.cost >= 0)) throw new Error('도로 비용은 0 이상이어야 합니다.');
    if (e.blocked) continue;
    adj[e.from].push({ to: e.to, cost: e.cost });
    if (!e.oneway) adj[e.to].push({ to: e.from, cost: e.cost });
    const a = nodes[e.from], b = nodes[e.to];
    const d = distance(a.x, a.y, b.x, b.y);
    if (d > 1e-9) minRatio = Math.min(minRatio, e.cost / d);
  }
  const heuristicScale = Number.isFinite(minRatio) ? Math.min(1, minRatio) : 1;

  // 강하게 연결된 요소 — 출발·도착 후보를 가장 큰 도로망으로 제한해, 일방통행이 있어도 서로 오갈 수 있게 한다
  const { component, sizes } = stronglyConnectedComponents(n, adj);
  const mainComponent = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;

  return { ...data, adj, heuristicScale, component, mainComponent };
}

/**
 * 강하게 연결된 요소 (반복형 Tarjan). 양방향 도로만 있으면 일반 연결 요소와 같다.
 * @param adj adj[u] = [{ to }]
 * @returns { component: Int32Array, sizes: number[] }
 */
export function stronglyConnectedComponents(n, adj) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const component = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const u = top[0];
      if (top[1] < adj[u].length) {
        const v = adj[u][top[1]++].to;
        if (index[v] === -1) {
          index[v] = low[v] = counter++;
          stack.push(v);
          onStack[v] = 1;
          work.push([v, 0]);
        } else if (onStack[v]) {
          low[u] = Math.min(low[u], index[v]);
        }
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low[p] = Math.min(low[p], low[u]);
        }
        if (low[u] === index[u]) {
          const id = sizes.length;
          let size = 0, w;
          do {
            w = stack.pop();
            onStack[w] = 0;
            component[w] = id;
            size++;
          } while (w !== u);
          sizes.push(size);
        }
      }
    }
  }
  return { component, sizes };
}

/**
 * 실제 도로망(osm.js 결과)을 난이도·장애물 설정에 맞게 준비한다.
 * - 난이도: 사용할 도로 등급 (예: 쉬움 = 고속·간선도로만)
 * - 장애물 재배치: obstacleSeed에 따라 일부 도로를 '공사 중'으로 막는다
 */
export function prepareRealNetwork(data, { difficulty = 'normal', obstacleSeed = 1 } = {}) {
  const diff = data.difficulties?.[difficulty];
  if (!diff) throw new Error(`알 수 없는 난이도입니다: ${difficulty}`);
  const roads = new Set(diff.roads);
  const rand = mulberry32((hashString('closures') ^ (obstacleSeed * 2654435761)) >>> 0);
  const edges = [];
  for (const e of data.edges) {
    if (!roads.has(e.road)) continue;
    const blocked = !e.bridge && rand() < (diff.closureChance || 0);
    edges.push(blocked ? { ...e, blocked: true } : e);
  }
  return {
    ...data,
    edges,
    obstacles: [],
    meta: { ...data.meta, difficulty, obstacleSeed },
  };
}

/** 두 교차로를 직접 잇는 통행 가능한 도로 중 가장 싼 비용 (없으면 Infinity) */
export function edgeCost(graph, u, v) {
  let best = Infinity;
  for (const e of graph.adj[u]) if (e.to === v && e.cost < best) best = e.cost;
  return best;
}

/** (x, y)에서 가장 가까운 교차로. 기본적으로 가장 큰 도로망에 속한 교차로만 고른다. */
export function nearestNode(graph, x, y, { mainOnly = true } = {}) {
  let best = -1, bestD = Infinity;
  for (const node of graph.nodes) {
    if (mainOnly && graph.component[node.id] !== graph.mainComponent) continue;
    const d = distance(node.x, node.y, x, y);
    if (d < bestD) { bestD = d; best = node.id; }
  }
  return best;
}

/** 장소 id(예: 'hongdae')를 가장 가까운 교차로 번호로 바꾼다. */
export function placeToNode(graph, placeId) {
  const place = graph.places.find((p) => p.id === placeId);
  if (!place) throw new Error(`장소를 찾을 수 없습니다: ${placeId}`);
  return nearestNode(graph, place.x, place.y);
}

/** 교차로 근처의 장소 이름 (없으면 '교차로 #번호') */
export function describeNode(graph, nodeId) {
  const node = graph.nodes[nodeId];
  if (!node) return '-';
  let best = null, bestD = 1.2;
  for (const p of graph.places || []) {
    const d = distance(p.x, p.y, node.x, node.y);
    if (d < bestD) { bestD = d; best = p.name; }
  }
  if (best) return best;
  let district = null, districtD = Infinity;
  for (const d of graph.districts || []) {
    const dd = distance(d.x, d.y, node.x, node.y);
    if (dd < districtD) { districtD = dd; district = d.name; }
  }
  return district ? `${district} 부근` : `교차로 #${nodeId}`;
}
