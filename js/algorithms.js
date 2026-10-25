// algorithms.js — 다익스트라와 A* 탐색.
// 화면 표시나 애니메이션 코드와 완전히 분리되어 있으며, 탐색 과정을 기록만 한다.
// 두 알고리즘은 같은 그래프(인접 리스트), 같은 출발·도착, 같은 도로 비용을 사용한다.

/** 최소 힙 우선순위 큐. (key, tie, 삽입 순서)로 비교해 결과가 항상 같게 나온다. */
export class MinHeap {
  constructor() {
    this.items = [];
    this.seq = 0;
  }
  get size() {
    return this.items.length;
  }
  push(value, key, tie = 0) {
    const item = { value, key, tie, seq: this.seq++ };
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function less(x, y) {
  if (x.key !== y.key) return x.key < y.key;
  if (x.tie !== y.tie) return x.tie < y.tie;
  return x.seq < y.seq;
}

/**
 * 공통 최선 우선 탐색. heuristic이 0이면 다익스트라, 직선거리면 A*.
 * 반환값:
 *   expandedOrder  확장(확정)한 노드를 탐색 순서대로
 *   expandedParent 각 확장 노드가 어느 노드에서 왔는지 (애니메이션용)
 *   path, cost, reached, expandedCount
 */
function bestFirstSearch(graph, start, goal, heuristic, algorithm) {
  const n = graph.nodes.length;
  if (!(start >= 0 && start < n)) throw new Error('출발점이 지도에 없습니다.');
  if (!(goal >= 0 && goal < n)) throw new Error('목적지가 지도에 없습니다.');

  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const expandedOrder = [];
  const expandedParent = [];
  let pushes = 1;

  g[start] = 0;
  heap.push(start, heuristic(start), heuristic(start));
  let reached = false;

  while (heap.size) {
    const { value: u } = heap.pop();
    if (closed[u]) continue; // 이미 확정된 노드의 오래된 항목
    closed[u] = 1;
    expandedOrder.push(u);
    expandedParent.push(parent[u]);
    if (u === goal) {
      reached = true;
      break;
    }
    const gu = g[u];
    for (const { to, cost } of graph.adj[u]) {
      if (closed[to]) continue;
      const nd = gu + cost;
      if (nd < g[to]) {
        g[to] = nd;
        parent[to] = u;
        const h = heuristic(to);
        heap.push(to, nd + h, h);
        pushes++;
      }
    }
  }

  const path = [];
  if (reached) {
    for (let v = goal; v !== -1; v = parent[v]) path.push(v);
    path.reverse();
  }

  return {
    algorithm,
    start,
    goal,
    reached,
    path,
    cost: reached ? g[goal] : Infinity,
    expandedOrder,
    expandedParent,
    expandedCount: expandedOrder.length,
    queuePushes: pushes,
  };
}

export function dijkstra(graph, start, goal) {
  return bestFirstSearch(graph, start, goal, () => 0, 'dijkstra');
}

/**
 * A*: 휴리스틱 = 목적지까지 직선거리 × graph.heuristicScale.
 * heuristicScale은 모든 도로에서 (비용 / 직선거리)의 최솟값(최대 1)이므로
 * 휴리스틱이 일관적(consistent)이고 최적 경로가 보장된다.
 */
export function astar(graph, start, goal) {
  const gx = graph.nodes[goal]?.x;
  const gy = graph.nodes[goal]?.y;
  const scale = graph.heuristicScale ?? 1;
  const nodes = graph.nodes;
  const h = (v) => Math.hypot(nodes[v].x - gx, nodes[v].y - gy) * scale;
  return bestFirstSearch(graph, start, goal, h, 'astar');
}

export const ALGORITHMS = {
  dijkstra: { id: 'dijkstra', label: 'DIJKSTRA', run: dijkstra },
  astar: { id: 'astar', label: 'A*', run: astar },
};
