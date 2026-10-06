// Phase 0 スパイク（使い捨て。本実装には持ち込まない）。計画書 5.3節の手順を最小限で実装して、iPhoneで確かめる。
import {
  Input, ALL_FORMATS, BlobSource, EncodedPacketSink, Output, Mp4OutputFormat,
  AppendOnlyStreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs';

const $ = (id) => document.getElementById(id);
const MB = 1024 * 1024;
const fmtMB = (n) => (n / MB).toFixed(1) + 'MB';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 無視 */ } },
};

// ---------------- ログ（画面と localStorage） ----------------
const logLines = [];
let logDirty = false;
function log(msg, cls) {
  const t = (performance.now() / 1000).toFixed(1).padStart(7);
  const line = `${t} ${msg}`;
  logLines.push(line);
  if (logLines.length > 3000) logLines.shift();
  const el = $('log');
  const span = document.createElement('div');
  span.textContent = line; if (cls) span.className = cls;
  el.appendChild(span);
  while (el.childNodes.length > 300) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
  logDirty = true;
}
setInterval(() => { if (logDirty) { store.set('spike.log', JSON.stringify(logLines.slice(-80))); logDirty = false; } }, 1000);
window.addEventListener('error', (e) => log('window.error: ' + e.message, 'ng'));
let abortCount = 0;
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && r.name === 'AbortError') { abortCount++; if (abortCount === 1) log('unhandledrejection: AbortError（世代切替で旧Outputを破棄したときの想定内のエラー。以後は数えるだけ）'); e.preventDefault(); return; }
  log('unhandledrejection: ' + (r && (r.stack || r.message || r)), 'ng');
});

// ---------------- 前回のセッション（クラッシュ・再読み込みの検出） ----------------
(function showPrev() {
  const loads = Number(store.get('spike.loads') || '0') + 1;
  store.set('spike.loads', String(loads));
  const clean = store.get('spike.clean');
  const alive = store.get('spike.alive');
  let s = `ページの読み込み回数: ${loads}\n`;
  if (alive) {
    const a = JSON.parse(alive);
    s += `前回の最終状態: ${new Date(a.t).toLocaleTimeString()} / currentTime=${a.ct} / ${a.note}\n`;
    s += clean === '1' ? '前回は正常に閉じられました（pagehide を受信）\n' : '前回は pagehide を受けずに終了しています（タブの再読み込み・クラッシュ・強制終了の可能性）\n';
  }
  const pl = store.get('spike.log');
  if (pl) s += '--- 前回ログ末尾 ---\n' + JSON.parse(pl).slice(-12).join('\n');
  $('prev').textContent = s;
  store.set('spike.clean', '0');
})();
window.addEventListener('pagehide', () => store.set('spike.clean', '1'));
setInterval(() => {
  const v = $('v');
  store.set('spike.alive', JSON.stringify({ t: Date.now(), ct: Number(v.currentTime.toFixed(1)), note: mse ? 'MSE再生中' : (v.src ? 'ネイティブ' : '待機') }));
}, 1000);

// ---------------- S1-a ファイル選択 ----------------
const S = { video: null };
const variants = [
  { id: 'multi', label: '① 1ボタン・複数選択（accept 無し）', multiple: true },
  { id: 'none', label: '② 動画1つ（accept 無し）' },
  { id: 'videostar', label: '③ 動画1つ（accept="video/*"）', accept: 'video/*' },
  { id: 'ext', label: '④ 動画1つ（accept=".mkv,.webm,.mp4,.mov,video/*"）', accept: '.mkv,.webm,.mp4,.mov,video/*' },
  { id: 'json', label: '⑤ チャット（accept=".json,application/json"）', accept: '.json,application/json' },
  { id: 'sqlite', label: '⑥ 絵文字（accept=".sqlite,.db"）', accept: '.sqlite,.db' },
];
const isVideoName = (n) => /\.(mp4|m4v|mov|webm|mkv)$/i.test(n);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join(' ');
for (const v of variants) {
  const lab = document.createElement('label'); lab.className = 'pick'; lab.textContent = v.label; lab.htmlFor = 'in-' + v.id;
  const inp = document.createElement('input'); inp.type = 'file'; inp.id = 'in-' + v.id;
  if (v.multiple) inp.multiple = true;
  if (v.accept) inp.accept = v.accept;
  let tClick = 0;
  inp.addEventListener('click', () => { tClick = performance.now(); });
  inp.addEventListener('change', async () => {
    const dt = ((performance.now() - tClick) / 1000).toFixed(1);
    const files = [...inp.files];
    log(`[${v.id}] ${files.length}件を選択（ダイアログ開始→確定 ${dt}秒）`);
    let html = `<table><tr><th>${v.id}</th><th>size</th><th>type</th><th>先頭16B</th></tr>`;
    for (const f of files) {
      const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
      html += `<tr><td>${f.name}</td><td>${fmtMB(f.size)} (${f.size})</td><td>${f.type || '(空)'}</td><td>${hex(head)}</td></tr>`;
      log(`  ${f.name} size=${f.size} type=${f.type || '(空)'} head=${hex(head.slice(0, 8))}`);
      if (isVideoName(f.name)) { S.video = f; }
    }
    $('pickinfo').innerHTML = html + '</table>' + `<div class="note">使う動画: ${S.video ? S.video.name : '(なし)'}</div>`;
  });
  $('pickers').append(lab, inp);
}

// ---------------- S1-b ネイティブ再生 ----------------
const v = $('v');
let nativeUrl = null;
for (const ev of ['loadedmetadata', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'seeked', 'ended', 'error', 'ratechange', 'emptied', 'abort']) {
  v.addEventListener(ev, () => {
    let extra = '';
    if (ev === 'loadedmetadata') extra = ` duration=${v.duration} ${v.videoWidth}x${v.videoHeight}`;
    if (ev === 'error') extra = ` code=${v.error && v.error.code} msg=${v.error && v.error.message}`;
    if (ev === 'seeking' || ev === 'seeked' || ev === 'waiting' || ev === 'playing') extra = ` ct=${v.currentTime.toFixed(2)}`;
    log(`video:${ev}${extra}`, ev === 'error' ? 'ng' : undefined);
  });
}
$('rate').addEventListener('change', () => { v.preservesPitch = true; v.playbackRate = Number($('rate').value); log('rate=' + v.playbackRate); });
$('btnNative').addEventListener('click', () => {
  if (!S.video) { log('動画が未選択', 'ng'); return; }
  stopMse();
  if (nativeUrl) URL.revokeObjectURL(nativeUrl);
  nativeUrl = URL.createObjectURL(S.video);
  v.preservesPitch = true;
  v.src = nativeUrl;
  log(`ネイティブ再生: ${S.video.name} ${fmtMB(S.video.size)}`);
});
$('btnRevoke').addEventListener('click', () => {
  v.pause(); v.removeAttribute('src'); v.load();
  if (nativeUrl) { URL.revokeObjectURL(nativeUrl); nativeUrl = null; }
  stopMse(); log('停止・URL解放');
});
const rangesStr = (tr) => { const a = []; for (let i = 0; i < tr.length; i++) a.push(`[${tr.start(i).toFixed(1)}-${tr.end(i).toFixed(1)}]`); return a.join(' ') || '-'; };
setInterval(() => {
  const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  $('vstat').textContent = `ct=${v.currentTime.toFixed(1)} / dur=${isFinite(v.duration) ? v.duration.toFixed(1) : v.duration} rate=${v.playbackRate} paused=${v.paused} ready=${v.readyState} net=${v.networkState}\n` +
    `buffered=${rangesStr(v.buffered)}` + (q ? `\ndropped=${q.droppedVideoFrames}/${q.totalVideoFrames}` : '');
}, 500);

// ---------------- S2 MSE ----------------
const MSClass = window.ManagedMediaSource || window.MediaSource;
const TYPE_LIST = [
  // 映像のみ（音声が原因かを切り分ける）
  'video/mp4; codecs="avc1.42c028"', 'video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.4d4028"',
  'video/mp4; codecs="vp09.00.40.08"', 'video/mp4; codecs="vp09.00.10.08"', 'video/mp4; codecs="av01.0.08M.08"', 'video/mp4; codecs="av01.0.12M.08"',
  // 音声のみ
  'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="opus"', 'audio/mp4; codecs="Opus"', 'audio/webm; codecs="opus"', 'audio/webm; codecs="vorbis"',
  // 映像＋音声（mp4）
  'video/mp4; codecs="avc1.640028, mp4a.40.2"', 'video/mp4; codecs="avc1.42c028, opus"', 'video/mp4; codecs="avc1.640028, opus"',
  'video/mp4; codecs="vp09.00.40.08, opus"', 'video/mp4; codecs="av01.0.08M.08, opus"',
  'video/mp4; codecs="vp09.00.40.08, mp4a.40.2"', 'video/mp4; codecs="av01.0.08M.08, mp4a.40.2"',
  // WebM
  'video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp09.00.40.08, opus"', 'video/webm; codecs="av01.0.08M.08, opus"', 'video/webm; codecs="vp8, vorbis"',
];
function typesReport() {
  let s = `ManagedMediaSource: ${!!window.ManagedMediaSource}  MediaSource: ${!!window.MediaSource}  WebCodecs(VideoDecoder): ${!!window.VideoDecoder}\n`;
  const lines = [s.trim()];
  for (const t of TYPE_LIST) {
    const m = window.ManagedMediaSource ? window.ManagedMediaSource.isTypeSupported(t) : null;
    const n = window.MediaSource ? window.MediaSource.isTypeSupported(t) : null;
    const c = document.createElement('video').canPlayType(t) || '(空)';
    const line = `${t}  MMS=${m} MS=${n} canPlay=${c}`;
    lines.push(line); s += line + '\n';
  }
  return { s, lines };
}
$('btnTypes').addEventListener('click', () => {
  const r = typesReport();
  $('types').textContent = r.s;
  for (const l of r.lines) log('[types] ' + l);
});

async function openInput(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { maxCacheSize: 4 * MB }) });
  const vTrack = await input.getPrimaryVideoTrack();
  const aTrack = await input.getPrimaryAudioTrack();
  return { input, vTrack, aTrack };
}

$('btnProbe').addEventListener('click', async () => {
  if (!S.video) { log('動画が未選択', 'ng'); return; }
  const file = S.video; let s = `${file.name} ${fmtMB(file.size)}\n`;
  try {
    const { input, vTrack, aTrack } = await openInput(file);
    s += `format=${(await input.getFormat()).name}  mime=${await input.getMimeType()}\n`;
    s += `video: codec=${vTrack && vTrack.codec} param=${vTrack && await vTrack.getCodecParameterString()}  ${vTrack && vTrack.displayWidth}x${vTrack && vTrack.displayHeight}\n`;
    s += `audio: codec=${aTrack && aTrack.codec} param=${aTrack && await aTrack.getCodecParameterString()}\n`;
    const t0 = performance.now();
    const dur = await input.getDurationFromMetadata();
    s += `duration(metadata)=${dur}  (${(performance.now() - t0).toFixed(0)}ms)  ← null なら U6 該当\n`;
    const d = dur ?? await input.computeDuration();
    const bitrate = file.size / d; // バイト/秒
    s += `平均 ${(bitrate * 8 / 1e6).toFixed(1)}Mbps (${(bitrate / MB).toFixed(2)}MB/s)\n`;
    const sink = new EncodedPacketSink(vTrack);
    let maxGop = 0;
    for (const frac of [0.1, 0.5, 0.9]) {
      const t1 = performance.now();
      const k = await sink.getKeyPacket(d * frac);
      const n = k && await sink.getNextKeyPacket(k);
      if (k && n) { const gop = n.timestamp - k.timestamp; maxGop = Math.max(maxGop, gop); s += `  t=${(d * frac).toFixed(0)}s: キーフレーム ${k.timestamp.toFixed(2)} → ${n.timestamp.toFixed(2)} (GOP ${gop.toFixed(2)}秒) ${(performance.now() - t1).toFixed(0)}ms\n`; }
      else s += `  t=${(d * frac).toFixed(0)}s: キーフレームが取れない (${k && k.timestamp}, ${n && n.timestamp})\n`;
    }
    const F = maxGop * bitrate;
    s += `推定 F = GOP ${maxGop.toFixed(2)}秒 × ${(bitrate / MB).toFixed(2)}MB/s = ${fmtMB(F)}  → ` + (F < 30 * MB ? '通常' : F < 64 * MB ? '警告' : '断る（4.4節の暫定方針）') + '\n';
    const first = await sink.getFirstPacket();
    s += `先頭パケット: type=${first.type} ts=${first.timestamp}\n`;
    input.dispose();
  } catch (e) { s += 'エラー: ' + (e.stack || e); }
  $('types').textContent = s; for (const l of s.split('\n')) if (l) log('[probe] ' + l);
});

// ---- 直列キュー（計画 5.3節 手順3） ----
class OpQueue {
  constructor() { this.tail = Promise.resolve(); this.depth = 0; }
  add(fn) { this.depth++; const p = this.tail.then(fn).catch((e) => log('queue op error: ' + (e && e.message || e), 'ng')).finally(() => { this.depth--; }); this.tail = p; return p; }
}
function waitEnd(sb) {
  return new Promise((res, rej) => {
    const ok = () => { sb.removeEventListener('error', er); res(); };
    const er = () => { sb.removeEventListener('updateend', ok); rej(new Error('SourceBuffer error event')); };
    sb.addEventListener('updateend', ok, { once: true });
    sb.addEventListener('error', er, { once: true });
  });
}

class MsePlayer {
  constructor(file, video, opts) {
    this.file = file; this.v = video; this.o = opts;
    this.gen = 0; this.dead = false; this.queue = new OpQueue();
    this.frags = []; this.cur = null; this.curOutput = null;
    this.resident = 0; this.pending = 0;
    this.stats = { residentMax: 0, budgetWaits: 0, uaEvictAll: 0, appended: 0, appendCount: 0, maxAppendOK: 0, minAppendFail: Infinity, quota: 0, maxFrag: 0, rotations: 0, outputs: 0, seeks: 0, evicted: 0, pumpMs: 0, packets: 0, state: 'init' };
    this.firstPlayAt = null;
  }
  bufRanges() { return this.sb ? this.sb.buffered : { length: 0 }; }
  forwardSeconds() {
    const b = this.sb.buffered, ct = this.v.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= ct + 0.25 && b.end(i) > ct) return b.end(i) - ct;
    return 0;
  }
  forwardBytes() {
    const ct = this.v.currentTime; let sum = 0;
    for (const f of this.frags) if (f.t1 > ct && f.bytes) sum += f.bytes;
    return sum;
  }
  async init() {
    const { input, vTrack, aTrack } = await openInput(this.file);
    this.input = input; this.vTrack = vTrack; this.aTrack = aTrack;
    if (!vTrack) throw new Error('映像トラックが無い');
    this.vSink = new EncodedPacketSink(vTrack); this.aSink = aTrack ? new EncodedPacketSink(aTrack) : null;
    this.vCfg = await vTrack.getDecoderConfig(); this.aCfg = aTrack ? await aTrack.getDecoderConfig() : null;
    const vc = await vTrack.getCodecParameterString(), ac = aTrack ? await aTrack.getCodecParameterString() : null;
    // MP4内のOpusの正式なコーデック文字列は先頭大文字の "Opus"。iPhone(Safari 26.6.1)の ManagedMediaSource は、
    // MediabunnyがWebCodecs表記で返す小文字の "opus" を偽にする（実測）。そこで "Opus" に直した文字列を使う。
    const acMime = ac === 'opus' ? 'Opus' : ac;
    this.mime = `video/mp4; codecs="${vc}${acMime ? ', ' + acMime : ''}"`;
    log('MSE MIME: ' + this.mime);
    const ok = MSClass.isTypeSupported(this.mime);
    log(`isTypeSupported=${ok}`, ok ? 'ok' : 'ng');
    if (!ok) {
      const alts = [`video/mp4; codecs="${vc}"`, ac ? `audio/mp4; codecs="${ac}"` : null, `video/mp4; codecs="${vc}, mp4a.40.2"`].filter(Boolean);
      for (const a of alts) log(`  切り分け: ${a} → MSClass=${MSClass.isTypeSupported(a)} MS=${window.MediaSource ? window.MediaSource.isTypeSupported(a) : null}`, 'warn');
      throw new Error('isTypeSupported が偽: ' + this.mime);
    }
    this.duration = await input.getDurationFromMetadata();
    log('duration(metadata)=' + this.duration, this.duration == null ? 'warn' : undefined);
    if (this.duration == null) this.duration = await input.computeDuration();
    this.ms = new MSClass();
    this.v.disableRemotePlayback = true; this.v.preservesPitch = true;
    for (const ev of ['startstreaming', 'endstreaming', 'sourceopen', 'sourceended', 'sourceclose']) this.ms.addEventListener(ev, () => log('ms:' + ev + ' streaming=' + this.ms.streaming));
    this.url = URL.createObjectURL(this.ms);
    const open = new Promise((r) => this.ms.addEventListener('sourceopen', r, { once: true }));
    this.v.src = this.url;
    await open;
    this.sb = this.ms.addSourceBuffer(this.mime);
    this.ms.duration = this.duration;
    this.sb.addEventListener('bufferedchange', () => {
      if (this.sb.buffered.length === 0 && this.resident > 0) { this.stats.uaEvictAll++; log(`UAがバッファを全部追い出した（常駐推定 ${fmtMB(this.resident)} → 0）`, 'warn'); this.resident = 0; }
    });
    this.sb.addEventListener('error', () => log('sb:error', 'ng'));
    this.onTime = () => this.evict(false);
    this.v.addEventListener('timeupdate', this.onTime);
    this.onSeeking = () => this.handleSeeking();
    this.v.addEventListener('seeking', this.onSeeking);
    this.v.addEventListener('playing', () => { if (!this.firstPlayAt) { this.firstPlayAt = performance.now(); log('初回 playing'); } });
    this.stats.state = 'ready';
  }
  inBuffer(t) { const b = this.sb.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) > t) return true; return false; }
  // シークの合流：つまみのドラッグで seeking が連発しても、最後の位置から SEEK_DEBOUNCE_MS 経ってから1回だけ切り替える。
  // （GOPが長いと、1世代の供給に数秒かかり、連発のたびに作り直すと何も追加されないまま止まるため）
  handleSeeking() {
    if (this.inBuffer(this.v.currentTime)) { clearTimeout(this.seekTimer); return; }
    this.stats.seekEvents = (this.stats.seekEvents || 0) + 1;
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => this.doSeek(), 250);
  }
  async doSeek() {
    const t = this.v.currentTime;
    if (this.inBuffer(t)) return;
    const tSeek = performance.now();
    this.stats.seeks++;
    log(`seek ${t.toFixed(1)}s: バッファ外 → 世代切替（合流したseeking=${this.stats.seekEvents}）`);
    this.stats.seekEvents = 0;
    const myGen = ++this.gen;                       // 手順6(1)
    if (this.curOutput) { this.curOutput.cancel().catch((e) => log('旧Output.cancel: ' + e)); this.curOutput = null; }  // (3) awaitしない
    await this.queue.tail;                          // 旧世代の操作は即resolveされる (2)(4)
    if (myGen !== this.gen) return;
    try {
      if (this.ms.readyState === 'open' && this.sb.updating) { this.sb.abort(); }
      while (this.sb.updating) await waitEnd(this.sb);
      if (this.sb.buffered.length) { const e = waitEnd(this.sb); this.sb.remove(0, Infinity); await e; }   // ended→open も remove が戻す
    } catch (e) { log('seek reset error: ' + e, 'ng'); }
    this.frags = [];
    this.pump(myGen, t).then(() => { }, (e) => log('pump error: ' + (e && e.stack || e), 'ng'));
    if (!this.seekT0) {
      this.seekT0 = tSeek;
      const onPl = () => { log(`seek→playing ${(performance.now() - this.seekT0).toFixed(0)}ms`); this.seekT0 = 0; this.v.removeEventListener('playing', onPl); };
      this.v.addEventListener('playing', onPl);
    }
  }
  async removeRange(a, b) {
    if (!(b > a)) return;
    await this.queue.add(async () => {
      while (this.sb.updating) await waitEnd(this.sb);
      const e = waitEnd(this.sb); this.sb.remove(a, b); await e;
      this.stats.evicted++;
    });
    let removed = 0; for (const f of this.frags) if (f.t1 <= b && f.bytes) removed += f.bytes;
    this.resident = Math.max(0, this.resident - removed);
    this.frags = this.frags.filter((f) => f.t1 > b);
  }
  // 計画 手順5：削除の終点は、フラグメント開始時刻のうち currentTime-back 以下で最大のもの
  async evict(force) {
    if (this.evicting || !this.sb || this.sb.buffered.length === 0) return;
    const pressure = this.resident > 0.5 * this.o.totalMiB * MB;
    const back = force ? 2 : (pressure ? 1 : this.o.back);
    const limit = this.v.currentTime - back;
    let end = -1;
    for (const f of this.frags) if (f.t0 <= limit && f.t0 > end) end = f.t0;
    const start0 = this.sb.buffered.start(0);
    if (end <= start0) return;
    this.evicting = true;
    try { await this.removeRange(start0, end); } finally { this.evicting = false; }
  }
  // 計画 手順2：チャンクは slice MiB ごとに分けて appendBuffer する（0なら分割しない）。
  // iPhoneで、空のSourceBufferへの 24.9MB の1回の追加が QuotaExceededError になったため（U11）。
  async appendOp(data, gen) {
    const step = this.o.slice > 0 ? Math.max(1, Math.floor(this.o.slice * MB)) : (data.byteLength || 1);
    for (let off = 0; off < data.byteLength; off += step) {
      const part = step >= data.byteLength ? data : data.subarray(off, Math.min(off + step, data.byteLength));
      const ok = await this.appendPart(part, gen);
      if (!ok) return;
    }
  }
  async appendPart(data, gen) {
    for (let attempt = 0; ; attempt++) {
      if (gen !== this.gen || this.dead) return false;
      while (this.sb.updating) await waitEnd(this.sb);
      try {
        const end = waitEnd(this.sb);
        this.sb.appendBuffer(data);
        await end;
        this.stats.appended += data.byteLength; this.stats.appendCount++;
        this.resident += data.byteLength; if (this.resident > this.stats.residentMax) this.stats.residentMax = this.resident;
        if (data.byteLength > this.stats.maxAppendOK) this.stats.maxAppendOK = data.byteLength;
        return true;
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          this.stats.quota++;
          if (data.byteLength < this.stats.minAppendFail) this.stats.minAppendFail = data.byteLength;
          log(`QuotaExceededError: 追加=${fmtMB(data.byteLength)} buffered=${rangesStr(this.sb.buffered)} 保持推定=${fmtMB(this.forwardBytes())} 試行${attempt + 1}（これまでの最大成功=${fmtMB(this.stats.maxAppendOK)}）`, 'ng');
          if (attempt >= 3) { this.fail('QuotaExceededError が解消しない（4.4節 U11）。分割MiBを小さくして再試行'); return false; }
          this.evicting = false; await this.evict(true);
          continue;
        }
        throw e;
      }
    }
  }
  fail(msg) { this.dead = true; this.stats.state = '失敗: ' + msg; log('致命的: ' + msg, 'ng'); }
  newOutput(gen) {
    const st = { total: 0, last: null };
    const self = this;
    const target = new AppendOnlyStreamTarget(new WritableStream({
      write(chunk) { st.total += chunk.byteLength; return self.queue.add(() => self.appendOp(chunk, gen)); },
    }));
    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented', minimumFragmentDuration: this.o.frag,
        onMoof: (data, position, timestamp) => {
          if (st.last) { st.last.bytes = position - st.last.pos; this.stats.maxFrag = Math.max(this.stats.maxFrag, st.last.bytes); }
          const f = { t0: timestamp, t1: Infinity, pos: position, bytes: null };
          const prev = this.frags[this.frags.length - 1]; if (prev && prev.t1 === Infinity) prev.t1 = timestamp;
          this.frags.push(f); st.last = f;
        },
      }),
      target,
    });
    const vSrc = new EncodedVideoPacketSource(this.vTrack.codec); output.addVideoTrack(vSrc);
    let aSrc = null; if (this.aTrack) { aSrc = new EncodedAudioPacketSource(this.aTrack.codec); output.addAudioTrack(aSrc); }
    this.stats.outputs++;
    return output.start().then(() => ({ output, vSrc, aSrc, st, fv: true, fa: true, t0: null }));
  }
  async finishOutput(c) {
    await c.output.finalize();
    if (c.st.last && c.st.last.bytes == null) { c.st.last.bytes = c.st.total - c.st.last.pos; this.stats.maxFrag = Math.max(this.stats.maxFrag, c.st.last.bytes); }
  }
  async waitForRoom(gen) {
    for (;;) {
      if (gen !== this.gen || this.dead) return;
      const fwd = this.forwardSeconds(), fb = this.forwardBytes();
      const streaming = this.ms.streaming !== false;
      if (this.queue.depth === 0 && (fwd < 2 || (streaming && fwd < this.o.fwdSec))) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // 計画 手順4(c)の修正：キーフレームを書くと、直前までのフラグメント(pending)がフラッシュされて追加される。
  // その前に「常駐＋pending が総量上限に収まる」まで待つ（収まらないものは追い出しの進行＝再生の進行を待つ）。
  async waitBudget(gen) {
    const budget = this.o.totalMiB * MB;
    let waited = 0;
    for (;;) {
      if (gen !== this.gen || this.dead) return;
      if (this.queue.depth === 0 && this.resident + this.pending <= budget) return;
      if (this.pending > budget) { this.fail(`1フラグメント(${fmtMB(this.pending)})が総量上限(${this.o.totalMiB}MiB)を超える`); return; }
      this.stats.budgetWaits++;
      await this.evict(false);
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
      if (waited % 5000 === 0) log(`総量待ち ${waited / 1000}秒 常駐=${fmtMB(this.resident)} pending=${fmtMB(this.pending)} ct=${this.v.currentTime.toFixed(1)} buffered=${rangesStr(this.sb.buffered)}`, 'warn');
      if (waited >= 20000) { this.fail(`総量待ちが20秒を超えた。常駐=${fmtMB(this.resident)} pending=${fmtMB(this.pending)}（GOPが長すぎて、再生中のGOPを残したまま次を入れられない）`); return; }
    }
  }
  async pump(gen, startTime) {
    this.stats.state = '供給中 ' + startTime.toFixed(1) + 's〜';
    const t0 = performance.now();
    let vp = (await this.vSink.getKeyPacket(startTime)) || (await this.vSink.getFirstKeyPacket());
    if (!vp) { this.fail('映像パケットが無い'); return; }
    const k = vp.timestamp;
    let ap = null;
    if (this.aSink) ap = (await this.aSink.getPacket(k)) || (await this.aSink.getFirstPacket());
    log(`pump開始 gen=${gen} start=${startTime.toFixed(1)} key=${k.toFixed(2)} audio=${ap ? ap.timestamp.toFixed(2) : '-'}`);
    let c = await this.newOutput(gen); this.cur = c; this.curOutput = c.output;
    try {
      while ((vp || ap) && gen === this.gen && !this.dead) {
        await this.waitForRoom(gen);
        if (gen !== this.gen || this.dead) break;
        const useV = vp && (!ap || vp.timestamp <= ap.timestamp);
        const pkt = useV ? vp : ap;
        if (pkt.timestamp < 0) { if (useV) vp = await this.vSink.getNextPacket(vp); else ap = await this.aSink.getNextPacket(ap); continue; }
        if (useV && pkt.type === 'key' && c.t0 !== null && pkt.timestamp - c.t0 >= this.o.rot) {
          await this.finishOutput(c);                               // 旧Outputの全チャンクが updateend まで済む
          if (gen !== this.gen) break;
          c = await this.newOutput(gen); this.cur = c; this.curOutput = c.output; this.stats.rotations++;
          log(`Outputローテーション #${this.stats.rotations} at ${pkt.timestamp.toFixed(1)}s`);
        }
        if (useV && pkt.type === 'key' && c.t0 !== null) { await this.waitBudget(gen); if (gen !== this.gen || this.dead) break; this.pending = 0; }
        this.pending += pkt.data.byteLength;
        if (c.t0 === null) c.t0 = pkt.timestamp;
        this.stats.packets++;
        if (useV) { await c.vSrc.add(pkt, c.fv ? { decoderConfig: this.vCfg } : undefined); c.fv = false; vp = await this.vSink.getNextPacket(vp); }
        else { await c.aSrc.add(pkt, c.fa ? { decoderConfig: this.aCfg } : undefined); c.fa = false; ap = await this.aSink.getNextPacket(ap); }
      }
      if (gen === this.gen && !this.dead) {
        await this.finishOutput(c);
        await this.queue.tail;
        if (this.ms.readyState === 'open') { try { this.ms.endOfStream(); log('endOfStream'); } catch (e) { log('endOfStream: ' + e, 'ng'); } }
        this.stats.state = '供給完了';
        const s = this.stats;
        log(`[summary] 供給完了 file=${this.file.name} 追加累計=${fmtMB(s.appended)} 1回の最大成功=${fmtMB(s.maxAppendOK)} 最小失敗=${s.minAppendFail === Infinity ? '-' : fmtMB(s.minAppendFail)} 最大フラグメント=${fmtMB(s.maxFrag)} Quota=${s.quota} ローテーション=${s.rotations} シーク=${s.seeks} slice=${this.o.slice}MiB 総量=${this.o.totalMiB}MiB 常駐最大=${fmtMB(s.residentMax)} 総量待ち=${s.budgetWaits} UA全追い出し=${s.uaEvictAll}`);
      }
    } catch (e) {
      if (gen === this.gen) { this.fail('pump例外: ' + (e && e.message)); log(String(e && e.stack), 'ng'); }
    }
    this.stats.pumpMs += performance.now() - t0;
  }
  start() { const g = ++this.gen; return this.pump(g, 0); }
  dispose() {
    this.dead = true; this.gen++;
    this.v.removeEventListener('timeupdate', this.onTime); this.v.removeEventListener('seeking', this.onSeeking);
    if (this.curOutput) this.curOutput.cancel().catch(() => { });
    try { if (this.input) this.input.dispose(); } catch { /* 無視 */ }
    try { if (this.url) URL.revokeObjectURL(this.url); } catch { /* 無視 */ }
  }
}

let mse = null;
function stopMse() { if (mse) { mse.dispose(); mse = null; log('MSE破棄'); } }
$('btnMseStop').addEventListener('click', () => { v.pause(); stopMse(); v.removeAttribute('src'); v.load(); });
$('btnMse').addEventListener('click', async () => {
  if (!S.video) { log('動画が未選択', 'ng'); return; }
  if (!MSClass) { log('MediaSource も ManagedMediaSource も無い', 'ng'); return; }
  stopMse();
  if (nativeUrl) { URL.revokeObjectURL(nativeUrl); nativeUrl = null; }
  const o = { fwdSec: Number($('oFwdSec').value), fwdMiB: Number($('oFwdMiB').value), back: Number($('oBack').value), rot: Number($('oRot').value), frag: Number($('oFrag').value), slice: Number($('oSlice').value), totalMiB: Number($('oTotal').value) };
  log(`MSE開始 ${S.video.name} opts=${JSON.stringify(o)} class=${MSClass === window.ManagedMediaSource ? 'ManagedMediaSource' : 'MediaSource'}`);
  const p = new MsePlayer(S.video, v, o); mse = p;
  try { await p.init(); p.start().then(() => { }, (e) => log('pump error: ' + e, 'ng')); }
  catch (e) { log('MSE初期化エラー: ' + (e && e.stack || e), 'ng'); }
});
setInterval(() => {
  if (!mse || !mse.sb) { $('mstat').textContent = '(MSE未使用)'; return; }
  const s = mse.stats;
  $('mstat').textContent =
    `状態: ${s.state}  MS.readyState=${mse.ms.readyState} streaming=${mse.ms.streaming} sb.updating=${mse.sb.updating} queue=${mse.queue.depth}\n` +
    `ct=${v.currentTime.toFixed(1)} 先読み=${mse.forwardSeconds().toFixed(1)}秒 / 前方推定=${fmtMB(mse.forwardBytes())}\n` +
    `buffered=${rangesStr(mse.sb.buffered)}\n` +
    `常駐推定=${fmtMB(mse.resident)} (最大 ${fmtMB(s.residentMax)}) pending=${fmtMB(mse.pending)} 総量待ち=${s.budgetWaits}回 UA全追い出し=${s.uaEvictAll}回\n` +
    `追加累計=${fmtMB(s.appended)} (${s.appendCount}回) 1回の追加の最大成功=${fmtMB(s.maxAppendOK)} 最小失敗=${s.minAppendFail === Infinity ? '-' : fmtMB(s.minAppendFail)} 最大フラグメント=${fmtMB(s.maxFrag)} 保持フラグメント数=${mse.frags.length}\n` +
    `Output数=${s.outputs} ローテーション=${s.rotations} シーク(バッファ外)=${s.seeks} 削除=${s.evicted}回 Quota=${s.quota} パケット=${s.packets}`;
}, 500);

$('btnCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(logLines.join('\n')); log('ログをコピーしました'); } catch (e) { log('コピー失敗: ' + e, 'ng'); } });
$('btnClear').addEventListener('click', () => { $('log').textContent = ''; logLines.length = 0; });

// 自動テスト用のフック（デスクトップのブラウザでの動作確認に使う）
window.__spike = { S, log, startMse: (file, opts) => { S.video = file; return (async () => { stopMse(); const o = Object.assign({ fwdSec: 30, fwdMiB: 64, back: 15, rot: 300, frag: 2, slice: 4, totalMiB: 80 }, opts || {}); const p = new MsePlayer(file, v, o); mse = p; await p.init(); p.start(); return p; })(); }, get mse() { return mse; } };
log('スパイクページを読み込みました。UA=' + navigator.userAgent);
