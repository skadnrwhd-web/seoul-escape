// metrics.js — 비교 지표 계산.
// 실행 시간은 탐색 함수 호출만 잰다. 화면 그리기·애니메이션·영상 인코딩은 포함하지 않는다.

import { dijkstra, astar } from './algorithms.js';
import { edgeCost } from './map.js';

const now = () => performance.now();

/**
 * 두 알고리즘을 한 번씩 실행해 탐색 기록을 얻고, 따로 반복 실행해 평균 계산 시간을 잰다.
 * 아주 짧은 시간은 한 번만 재면 타이머 해상도 때문에 0이나 들쭉날쭉한 값이 나오므로
 * 일정 시간(budgetMs) 동안 번갈아 반복 실행한 평균을 사용한다.
 */
export function runRace(graph, start, goal, { budgetMs = 60, maxRuns = 2000, batch = 5 } = {}) {
  const dRes = dijkstra(graph, start, goal);
  const aRes = astar(graph, start, goal);

  // 워밍업 (JIT 최적화 차이로 인한 불공정을 줄임)
  for (let i = 0; i < 3; i++) { dijkstra(graph, start, goal); astar(graph, start, goal); }

  let dTotal = 0, aTotal = 0, runs = 0;
  const begin = now();
  while (runs < maxRuns && (runs < 10 || now() - begin < budgetMs)) {
    let t0 = now();
    for (let i = 0; i < batch; i++) dijkstra(graph, start, goal);
    dTotal += now() - t0;
    t0 = now();
    for (let i = 0; i < batch; i++) astar(graph, start, goal);
    aTotal += now() - t0;
    runs += batch;
  }

  return {
    dijkstra: buildMetrics(graph, dRes, { avgMs: dTotal / runs, runs }),
    astar: buildMetrics(graph, aRes, { avgMs: aTotal / runs, runs }),
  };
}

/** 탐색 결과 + 시간 측정값 → 화면/영상에 표시할 지표 */
export function buildMetrics(graph, result, timing) {
  const uniqueExpanded = new Set(result.expandedOrder).size;
  const pathLength = computePathLength(graph, result.path);
  return {
    algorithm: result.algorithm,
    result,
    reached: result.reached,
    expandedCount: uniqueExpanded,
    pathLength,
    pathNodes: result.path.length,
    timeMs: timing.avgMs,
    timingRuns: timing.runs,
  };
}

/** 경로의 실제 도로 비용 합계 (탐색 내부 값과 별개로 다시 계산) */
export function computePathLength(graph, path) {
  if (!path || path.length === 0) return Infinity;
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    const c = edgeCost(graph, path[i - 1], path[i]);
    if (!Number.isFinite(c)) throw new Error('경로에 실제로 없는 도로가 포함되어 있습니다.');
    sum += c;
  }
  return sum;
}

export function formatDistance(value, unitLabel = 'km') {
  if (!Number.isFinite(value)) return '도달 불가';
  return `${value.toFixed(2)} ${unitLabel}`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1) return `${ms.toFixed(3)} ms`;
  return `${ms.toFixed(2)} ms`;
}

/** 실제 수치 그대로의 비교 문장. 작은 시간 차이는 '비슷함'으로 표시한다. */
export function compareMetrics(d, a) {
  const lines = {};
  if (!d.reached || !a.reached) {
    lines.nodes = '목적지에 도달할 수 없는 경로입니다.';
    lines.path = '-';
    lines.time = '-';
    lines.headline = '도달 불가';
    return lines;
  }
  const diffNodes = d.expandedCount - a.expandedCount;
  if (diffNodes > 0) {
    const pct = Math.round((diffNodes / d.expandedCount) * 100);
    lines.nodes = `A*가 ${pct}% 적게 탐색 (${d.expandedCount} → ${a.expandedCount})`;
  } else if (diffNodes < 0) {
    lines.nodes = `A*가 ${-diffNodes}개 더 탐색`;
  } else {
    lines.nodes = '탐색 노드 수 같음';
  }

  const pathDiff = Math.abs(d.pathLength - a.pathLength);
  lines.path = pathDiff < 1e-9 ? '두 경로 길이 동일 (최적 경로)' : `경로 길이 차이 ${pathDiff.toFixed(3)}`;

  const fast = Math.min(d.timeMs, a.timeMs);
  const slow = Math.max(d.timeMs, a.timeMs);
  if (slow - fast < 0.02 || slow / Math.max(fast, 1e-9) < 1.15) {
    lines.time = '계산 시간은 측정 오차 범위 내에서 비슷함';
  } else {
    const who = a.timeMs < d.timeMs ? 'A*' : '다익스트라';
    lines.time = `${who}가 약 ${(slow / fast).toFixed(1)}배 빠름 (이 기기 기준)`;
  }
  lines.headline = diffNodes > 0 ? 'A* WINS' : diffNodes < 0 ? 'DIJKSTRA WINS' : 'DRAW';
  return lines;
}
