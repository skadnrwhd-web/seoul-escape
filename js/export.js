// export.js — 쇼츠 영상 내보내기.
// 기본: 프레임을 한 장씩 그려 로컬 서버로 보내고, 서버의 FFmpeg가 MP4로 인코딩한다.
// 대체: 서버나 FFmpeg를 쓸 수 없으면 브라우저 MediaRecorder로 WebM(또는 지원 시 MP4)을 실시간 녹화해 내려받는다.
// 어떤 경우에도 외부 서비스로 파일을 올리지 않는다.

import { renderShortsFrame } from './recorder.js';

export async function checkServer() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return { server: false, ffmpeg: false };
    const j = await res.json();
    return { server: true, ffmpeg: !!j.ffmpeg, ffmpegVersion: j.ffmpegVersion, outputDir: j.outputDir };
  } catch {
    return { server: false, ffmpeg: false };
  }
}

async function api(path, body, isBase64 = false) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': isBase64 ? 'text/plain; charset=base64' : 'application/json' },
    body: isBase64 ? body : JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
  return data;
}

function makeCanvas(w, h, needDom = false) {
  if (!needDom && typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// toDataURL은 동기 방식이라, 탭이 뒤로 가도 toBlob처럼 콜백이 늦어지지 않는다 (측정: 프레임당 약 25ms).
function canvasToJpegBase64(canvas, quality) {
  const url = canvas.toDataURL('image/jpeg', quality);
  const comma = url.indexOf(',');
  if (!url.startsWith('data:image/jpeg') || comma < 0) throw new Error('이 브라우저에서 JPEG 프레임을 만들 수 없습니다.');
  return url.slice(comma + 1);
}

/**
 * 장면을 MP4로 만든다 (로컬 서버 + FFmpeg).
 * @returns {fileName, filePath, url, sizeBytes, probe}
 */
export async function exportMp4(scene, { onProgress = () => {}, signal, quality = 0.92 } = {}) {
  const canvas = makeCanvas(scene.width, scene.height, true);
  const ctx = canvas.getContext('2d');
  const { id } = await api('/api/video/start', { width: scene.width, height: scene.height, fps: scene.fps, format: 'jpeg' });
  let pending = Promise.resolve();
  try {
    for (let i = 0; i < scene.totalFrames; i++) {
      if (signal?.aborted) throw new DOMException('사용자가 영상 제작을 취소했습니다.', 'AbortError');
      renderShortsFrame(ctx, i, scene);
      const jpeg = canvasToJpegBase64(canvas, quality);
      await pending; // 이전 프레임 전송이 끝난 뒤 다음 프레임을 보낸다 (순서 보장)
      pending = api(`/api/video/${id}/frame`, jpeg, true);
      onProgress({ stage: 'frames', done: i + 1, total: scene.totalFrames });
    }
    await pending;
    onProgress({ stage: 'encoding', done: scene.totalFrames, total: scene.totalFrames });
    return await api(`/api/video/${id}/finish`);
  } catch (err) {
    await pending.catch(() => {});
    await api(`/api/video/${id}/cancel`).catch(() => {});
    throw err;
  }
}

/** 브라우저 녹화 대체 경로. 실시간으로 재생하며 녹화하므로 영상 길이만큼 시간이 걸린다. */
export async function exportWithMediaRecorder(scene, { onProgress = () => {}, signal } = {}) {
  if (typeof MediaRecorder === 'undefined') throw new Error('이 브라우저는 영상 녹화를 지원하지 않습니다. Chrome 최신 버전을 사용해 주세요.');
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('지원되는 영상 형식을 찾지 못했습니다.');
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

  const canvas = makeCanvas(scene.width, scene.height, true);
  const ctx = canvas.getContext('2d');
  renderShortsFrame(ctx, 0, scene);
  const stream = canvas.captureStream(scene.fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start(1000);

  const startTime = performance.now();
  await new Promise((resolve, reject) => {
    const frameMs = 1000 / scene.fps;
    let last = -1;
    const timer = setInterval(() => {
      if (signal?.aborted) { clearInterval(timer); reject(new DOMException('사용자가 영상 제작을 취소했습니다.', 'AbortError')); return; }
      // 화면은 프레임 번호로만 결정되므로 내용은 항상 같다 (녹화 타이밍만 실시간)
      const i = Math.min(scene.totalFrames - 1, Math.floor((performance.now() - startTime) / frameMs));
      if (i !== last) { renderShortsFrame(ctx, i, scene); last = i; }
      onProgress({ stage: 'recording', done: i + 1, total: scene.totalFrames });
      if (i >= scene.totalFrames - 1) { clearInterval(timer); resolve(); }
    }, frameMs / 2);
  }).finally(() => recorder.state !== 'inactive' && recorder.stop());
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mimeType });
  const fileName = `${timestampName()}.${ext}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { fileName, filePath: null, url: null, sizeBytes: blob.size, format: ext, downloaded: true };
}

export function timestampName(prefix = 'seoul_escape') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
