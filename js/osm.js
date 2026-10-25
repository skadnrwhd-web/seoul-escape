// osm.js — OpenStreetMap(Overpass JSON) 데이터를 게임용 도로망 데이터로 바꾸는 변환기.
// 브라우저와 Node 양쪽에서 동작하며, 실제 내려받기는 tools/fetch-seoul-map.js가 담당한다.
//
// 변환 규칙
//  - highway 등급이 설정의 roadClasses에 속하는 도로만 사용 (xxx_link는 같은 등급으로 취급)
//  - 교차로(두 도로 이상이 만나는 점)와 도로 끝점만 노드로 남기고, 그 사이의 굽은 점들은
//    이동 비용(도로를 따라간 실제 길이, km)에 합산한다 → 비용 ≥ 직선거리라 A* 휴리스틱이 안전
//  - oneway / junction=roundabout / motorway 기본 일방통행을 반영
//  - 범위(bbox) 밖으로 나가는 도로는 범위 경계에서 끊는다
//  - 가장 큰 '강하게 연결된' 도로망만 남겨, 남은 어떤 두 교차로 사이도 오갈 수 있게 한다

import { stronglyConnectedComponents } from './map.js';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_LICENSE = 'ODbL 1.0';

/** 위도·경도 → km 평면 좌표 (bbox 왼쪽 위가 0,0, 아래로 갈수록 y 증가) */
export function makeProjection(bbox) {
  const lat0 = ((bbox.south + bbox.north) / 2) * (Math.PI / 180);
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.574;
  return {
    project: (lat, lon) => ({ x: (lon - bbox.west) * kx, y: (bbox.north - lat) * ky }),
    bounds: { minX: 0, minY: 0, maxX: (bbox.east - bbox.west) * kx, maxY: (bbox.north - bbox.south) * ky },
    inside: (lat, lon) => lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east,
  };
}

/** 'primary_link' → 'primary' */
export function roadClassOf(highway) {
  return typeof highway === 'string' ? highway.replace(/_link$/, '') : null;
}

/** 1: 그려진 방향으로만, -1: 반대 방향으로만, 0: 양방향 */
export function onewayDirection(tags = {}) {
  const o = String(tags.oneway ?? '').toLowerCase();
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === 'no' || o === 'false' || o === '0') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * @param osm    Overpass JSON ({ elements: [...] })
 * @param config data/real-map-config.json 내용 (bbox, roadClasses, places, scenarios, difficulties)
 * @returns 도로망 데이터 (map.js buildGraph에 그대로 넘길 수 있음)
 */
export function osmToRoadNetwork(osm, config, { downloadedAt = null } = {}) {
  if (!osm || !Array.isArray(osm.elements)) throw new Error('OSM 데이터 형식이 아닙니다 (elements 배열 없음).');
  const proj = makeProjection(config.bbox);
  const classes = new Set(config.roadClasses);

  const coords = new Map(); // osm node id → {x, y}
  for (const el of osm.elements) {
    if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon) && proj.inside(el.lat, el.lon)) {
      coords.set(el.id, proj.project(el.lat, el.lon));
    }
  }

  // 1) 도로를 범위 안쪽 구간(run)으로 자르기
  const runs = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags || !Array.isArray(el.nodes)) continue;
    const t = el.tags;
    const cls = roadClassOf(t.highway);
    if (!classes.has(cls)) continue;
    if (t.area === 'yes' || t.access === 'no' || t.access === 'private') continue;
    const dir = onewayDirection(t);
    const isBridge = !!t.bridge && t.bridge !== 'no' && /대교|bridge/i.test(`${t.name || ''} ${t['name:en'] || ''}`);
    let cur = [];
    for (const id of el.nodes) {
      if (coords.has(id)) cur.push(id);
      else { if (cur.length > 1) runs.push({ refs: cur, cls, dir, isBridge }); cur = []; }
    }
    if (cur.length > 1) runs.push({ refs: cur, cls, dir, isBridge });
  }

  // 2) 교차로 찾기: 끝점이거나 두 번 이상 쓰인 점
  const uses = new Map();
  const keep = new Set();
  for (const r of runs) {
    for (const id of r.refs) uses.set(id, (uses.get(id) || 0) + 1);
    keep.add(r.refs[0]);
    keep.add(r.refs[r.refs.length - 1]);
  }
  for (const [id, n] of uses) if (n >= 2) keep.add(id);

  // 3) 교차로 사이를 하나의 도로(간선)로, 비용 = 도로를 따라간 길이
  const index = new Map(); // osm id → 임시 번호
  const tmpNodes = [];
  const idOf = (osmId) => {
    if (!index.has(osmId)) { index.set(osmId, tmpNodes.length); tmpNodes.push(coords.get(osmId)); }
    return index.get(osmId);
  };
  const edgeMap = new Map();
  const addEdge = (a, b, cost, dir, cls, isBridge) => {
    if (a === b) return;
    let from = a, to = b, oneway = dir !== 0;
    if (dir === -1) { from = b; to = a; }
    if (!oneway && from > to) [from, to] = [to, from];
    const key = `${from}>${to}>${oneway ? 1 : 0}`;
    const old = edgeMap.get(key);
    if (!old || cost < old.cost) edgeMap.set(key, { from, to, cost, oneway, road: cls, ...(isBridge ? { bridge: true } : {}) });
  };
  for (const r of runs) {
    let start = r.refs[0];
    let len = 0;
    for (let i = 1; i < r.refs.length; i++) {
      const p = coords.get(r.refs[i - 1]), q = coords.get(r.refs[i]);
      len += Math.hypot(p.x - q.x, p.y - q.y);
      if (keep.has(r.refs[i])) {
        addEdge(idOf(start), idOf(r.refs[i]), len, r.dir, r.cls, r.isBridge);
        start = r.refs[i];
        len = 0;
      }
    }
  }
  // 같은 두 교차로를 잇는 양방향 도로가 있으면, 같은 구간의 일방통행 중복은 버린다
  const edgesAll = [...edgeMap.values()].filter((e) => {
    if (!e.oneway) return true;
    const both = edgeMap.get(`${Math.min(e.from, e.to)}>${Math.max(e.from, e.to)}>0`);
    return !both || both.cost > e.cost;
  });

  // 4) 가장 큰 강연결 요소만 남기고 번호 다시 매기기
  const n = tmpNodes.length;
  const adj = Array.from({ length: n }, () => []);
  for (const e of edgesAll) {
    adj[e.from].push({ to: e.to });
    if (!e.oneway) adj[e.to].push({ to: e.from });
  }
  const { component, sizes } = stronglyConnectedComponents(n, adj);
  const main = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  const remap = new Int32Array(n).fill(-1);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    if (component[i] !== main) continue;
    remap[i] = nodes.length;
    nodes.push({ id: nodes.length, x: round(tmpNodes[i].x, 4), y: round(tmpNodes[i].y, 4) });
  }
  const edges = [];
  for (const e of edgesAll) {
    const from = remap[e.from], to = remap[e.to];
    if (from < 0 || to < 0) continue;
    // 좌표를 반올림해도 비용이 직선거리보다 작아지지 않게 (A* 휴리스틱 배율이 1에 가깝게 유지됨)
    const chord = Math.hypot(nodes[from].x - nodes[to].x, nodes[from].y - nodes[to].y);
    const cost = Math.ceil(Math.max(e.cost, chord) * 1e4) / 1e4;
    edges.push({ ...e, from, to, cost });
  }

  // 5) 장식: 강, 구 이름, 장소
  const waterLines = [];
  for (const el of osm.elements) {
    if (el.type === 'way' && el.tags?.waterway === 'river' && Array.isArray(el.geometry)) {
      waterLines.push(el.geometry.map((g) => { const p = proj.project(g.lat, g.lon); return [round(p.x, 3), round(p.y, 3)]; }));
    }
  }
  const districts = [];
  for (const el of osm.elements) {
    if (el.type === 'relation' && el.tags?.boundary === 'administrative' && el.center && el.tags.name) {
      if (!proj.inside(el.center.lat, el.center.lon)) continue;
      const p = proj.project(el.center.lat, el.center.lon);
      districts.push({ name: el.tags.name, x: round(p.x, 3), y: round(p.y, 3) });
    }
  }
  const places = (config.places || []).map((pl) => {
    const p = proj.project(pl.lat, pl.lon);
    return { id: pl.id, name: pl.name, x: round(p.x, 3), y: round(p.y, 3) };
  });

  return {
    meta: {
      name: config.name || '실제 도로망',
      isReal: true,
      source: 'OpenStreetMap',
      license: OSM_LICENSE,
      attribution: OSM_ATTRIBUTION,
      disclaimer: `실제 도로망 · 지도 데이터 ${OSM_ATTRIBUTION} (${OSM_LICENSE})`,
      unit: 'km',
      unitLabel: 'km',
      bbox: config.bbox,
      roadClasses: config.roadClasses,
      downloadedAt,
      note: '이동 비용 = 도로를 따라간 거리(km). 신호·정체·회전 제한은 반영하지 않음.',
    },
    bounds: proj.bounds,
    nodes,
    edges,
    waterLines,
    waterWidth: 0.7,
    districts,
    places,
    scenarios: config.scenarios || [],
    difficulties: config.difficulties || {},
  };
}

/** Overpass 질의문 (도로 + 강 + 구 경계 중심점) */
export function buildOverpassQuery(config) {
  const { south, west, north, east } = config.bbox;
  const classes = config.roadClasses.join('|');
  return `[out:json][timeout:240][bbox:${south},${west},${north},${east}];
way["highway"~"^(${classes})(_link)?$"]->.roads;
.roads out body qt;
node(w.roads);
out skel qt;
way["waterway"="river"]["name"~"한강"];
out geom qt;
rel["boundary"="administrative"]["admin_level"="6"];
out center tags qt;`;
}
