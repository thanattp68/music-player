'use strict';

/* ============ IndexedDB ============
 * songs : { id, name, artist, size, added }   metadata เบา
 * files : { id, blob, cover }                 ไฟล์เสียง + ปกอัลบั้ม (ดึงตอนเล่น)
 */
const DB_NAME = 'offline-music', DB_VERSION = 1;
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const txDone = tx => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
});
const reqDone = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* ============ ID3v2 (mp3): ชื่อเพลง ศิลปิน ปก ============ */
async function readID3(file) {
  const out = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (String.fromCharCode(...head.slice(0, 3)) !== 'ID3') return out;
    const ver = head[3];
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 6 * 1048576)).arrayBuffer());
    const dv = new DataView(buf.buffer);
    const dec = (b, enc) => new TextDecoder(['iso-8859-1', 'utf-16', 'utf-16be', 'utf-8'][enc] || 'utf-8')
      .decode(b).replace(/\0+$/, '').trim();
    let p = 0;
    while (p + 10 < buf.length && buf[p] !== 0) {
      const id = String.fromCharCode(...buf.slice(p, p + 4));
      const fs = ver === 4
        ? (buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7]
        : dv.getUint32(p + 4);
      const body = buf.slice(p + 10, p + 10 + fs);
      if (id === 'TIT2') out.title = dec(body.slice(1), body[0]);
      else if (id === 'TPE1') out.artist = dec(body.slice(1), body[0]);
      else if (id === 'APIC' && !out.cover) {
        const enc = body[0];
        let i = 1;
        while (body[i] !== 0) i++;
        const mime = dec(body.slice(1, i), 0) || 'image/jpeg';
        i += 2; // null + picture type
        if (enc === 1 || enc === 2) { while (!(body[i] === 0 && body[i + 1] === 0)) i++; i += 2; }
        else { while (body[i] !== 0) i++; i += 1; }
        out.cover = new Blob([body.slice(i)], { type: mime });
      }
      p += 10 + fs;
    }
  } catch (e) { /* อ่านแท็กไม่ได้ ข้ามไป */ }
  return out;
}

async function dbAddSong(file) {
  // แปลงเป็น Blob จริงก่อนเก็บ กัน iOS Safari ทำไฟล์อ้างอิงหาย
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' });
  const tags = await readID3(file);
  const meta = {
    name: tags.title || file.name.replace(/\.[^.]+$/, ''),
    artist: tags.artist || '',
    size: file.size, added: Date.now()
  };
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  const addReq = tx.objectStore('songs').add(meta);
  addReq.onsuccess = () => tx.objectStore('files').put({ id: addReq.result, blob, cover: tags.cover || null });
  await txDone(tx);
}
const dbGetAllSongs = () => reqDone(db.transaction('songs').objectStore('songs').getAll());
const dbGetFile = id => reqDone(db.transaction('files').objectStore('files').get(id));
const dbPutSong = s => reqDone(db.transaction('songs', 'readwrite').objectStore('songs').put(s));
async function dbDeleteSong(id) {
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  tx.objectStore('songs').delete(id);
  tx.objectStore('files').delete(id);
  await txDone(tx);
}

/* ============ State ============ */
const $ = id => document.getElementById(id);
const audio = $('audio'), listEl = $('library'), emptyEl = $('empty'), statusEl = $('status'), seekEl = $('seek');
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

let songs = [], currentId = null, currentUrl = null, coverUrl = null;
let shuffle = false, repeat = 'off', seeking = false;
let history = [], queue = [];            // history: ย้อนกลับ, queue: คิวสุ่มรอบนี้
let query = '', sortBy = store.get('sort', 'added');
let sleepTimer = null, sleepEnd = 0;
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
let speedIdx = 0, errorStreak = 0;

/* ============ Library ============ */
const SORTS = {
  added: (a, b) => a.added - b.added,
  name: (a, b) => a.name.localeCompare(b.name, 'th'),
  size: (a, b) => b.size - a.size
};
async function refreshLibrary() {
  songs = await dbGetAllSongs();
  songs.sort((a, b) => SORTS[sortBy](a, b) || a.name.localeCompare(b.name));
  renderLibrary();
  showStorage();
}
const visible = () => {
  const q = query.trim().toLowerCase();
  let l = curPl ? songs.filter(s => (s.pl || []).includes(curPl)) : songs;
  return q ? l.filter(s => (s.name + ' ' + s.artist).toLowerCase().includes(q)) : l;
};

function renderLibrary() {
  listEl.textContent = '';
  const list = visible();
  emptyEl.hidden = list.length > 0;
  renderPls();
  const mc = $('mascot'); if (mc) mc.hidden = songs.length > 0;
  emptyEl.textContent = songs.length
    ? 'ไม่พบเพลงที่ตรงกับคำค้น'
    : 'ยังไม่มีเพลง กด “เพิ่มเพลง” เพื่อเลือกไฟล์ .mp3 หรือ .m4a';
  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'track' + (s.id === currentId ? ' active' : '') + (selected.has(s.id) ? ' selected' : '');
    const main = document.createElement('button');
    main.className = 'track-main';
    const name = document.createElement('div');
    name.className = 'track-name'; name.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'track-meta';
    meta.textContent = (s.artist ? s.artist + ' · ' : '') + (s.size / 1048576).toFixed(1) + ' MB';
    main.append(name, meta);
    main.addEventListener('click', () => {
      if (!selectMode) return playById(s.id);
      selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id);
      renderLibrary(); updateSelbar();
    });

    const edit = document.createElement('button');
    edit.className = 'del'; edit.setAttribute('aria-label', 'แก้ชื่อเพลง'); edit.textContent = '✎';
    edit.addEventListener('click', () => renameSong(s));
    const del = document.createElement('button');
    del.className = 'del'; del.setAttribute('aria-label', 'ลบเพลง'); del.textContent = '✕';
    del.addEventListener('click', () => removeSong(s));
    li.append(main);
    if (selectMode) {
      const t = document.createElement('span');
      t.className = 'tick'; t.textContent = selected.has(s.id) ? '✓' : '';
      li.prepend(t);
    } else li.append(edit, del);
    listEl.append(li);
  }
}

let statusT;
function showStatus(msg, ms = 0) {
  statusEl.textContent = msg;
  statusEl.hidden = !msg;
  clearTimeout(statusT);
  if (ms) statusT = setTimeout(() => showStatus(''), ms);
}

async function showStorage() {
  const el = $('storage');
  if (!navigator.storage?.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  el.textContent = `ใช้พื้นที่ ${(usage / 1048576).toFixed(0)} MB จาก ${(quota / 1048576).toFixed(0)} MB · ${songs.length} เพลง`;
}

$('file-input').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  let ok = 0;
  for (const [i, f] of files.entries()) {
    showStatus(`กำลังบันทึก ${i + 1}/${files.length}: ${f.name}`);
    try { await dbAddSong(f); ok++; }
    catch (err) {
      showStatus(err && err.name === 'QuotaExceededError'
        ? 'พื้นที่เก็บข้อมูลเต็ม ไม่สามารถบันทึกเพิ่มได้' : 'บันทึกไม่สำเร็จ: ' + f.name);
      await refreshLibrary();
      return;
    }
  }
  showStatus(ok ? `เพิ่มแล้ว ${ok} เพลง` : '', 2500);
  await refreshLibrary();
});

// ลากวางไฟล์ (เดสก์ท็อป)
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const fs = [...e.dataTransfer.files].filter(f => /\.(mp3|m4a|flac|ogg|wav)$/i.test(f.name));
  if (!fs.length) return;
  const dt = new DataTransfer(); fs.forEach(f => dt.items.add(f));
  $('file-input').files = dt.files;
  $('file-input').dispatchEvent(new Event('change'));
});

$('search').addEventListener('input', e => { query = e.target.value; renderLibrary(); });
$('sort').value = sortBy;
$('sort').addEventListener('change', e => { sortBy = e.target.value; store.set('sort', sortBy); refreshLibrary(); });

async function renameSong(s) {
  const n = prompt('ชื่อเพลง', s.name);
  if (!n || !n.trim() || n.trim() === s.name) return;
  s.name = n.trim();
  await dbPutSong(s);
  if (s.id === currentId) { $('now-title').textContent = s.name; setMediaSession(s); }
  await refreshLibrary();
}

async function removeSong(s, ask = true) {
  if (ask && !confirm(`ลบ “${s.name}” ?`)) return;
  if (s.id === currentId) {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null; currentId = null;
    $('now-title').textContent = 'ยังไม่ได้เลือกเพลง';
    $('now-artist').textContent = '';
    setCover(null); updatePlayIcon();
    store.set('last', null);
  }
  history = history.filter(id => id !== s.id);
  queue = queue.filter(id => id !== s.id);
  await dbDeleteSong(s.id);
  await refreshLibrary();
}

/* ============ Playback ============ */
function setCover(blob) {
  if (coverUrl) URL.revokeObjectURL(coverUrl);
  coverUrl = blob ? URL.createObjectURL(blob) : null;
  const img = $('cover');
  img.hidden = !coverUrl;
  $('cover-ph').hidden = !!coverUrl;
  if (coverUrl) img.src = coverUrl;
}

async function playById(id, { pushHistory = true, startAt = 0, autoplay = true } = {}) {
  const song = songs.find(s => s.id === id);
  const rec = await dbGetFile(id);
  if (!song || !rec || !rec.blob) return;

  if (pushHistory && currentId !== null && currentId !== id) history.push(currentId);
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(rec.blob);
  currentId = id;
  audio.src = currentUrl;
  audio.playbackRate = SPEEDS[speedIdx];
  if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });

  $('now-title').textContent = song.name;
  $('now-artist').textContent = song.artist || '';
  setCover(rec.cover);
  renderLibrary();
  setMediaSession(song, rec.cover);
  store.set('last', { id, t: startAt });
  if (autoplay) { try { await audio.play(); } catch (e) { /* รอผู้ใช้กดเล่น */ } }
}

const indexOfCurrent = () => pool().findIndex(s => s.id === currentId);

function nextShuffleId() {
  if (!queue.length) {   // เริ่มรอบใหม่: Fisher-Yates
    queue = pool().map(s => s.id).filter(id => id !== currentId);
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  return queue.shift();
}

function next(auto = false) {
  if (!pool().length) return;
  if (auto && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  if (shuffle && pool().length > 1) {
    return playById(nextShuffleId());
  }
  let idx = indexOfCurrent() + 1;
  if (idx >= pool().length) {
    if (auto && repeat === 'off') { audio.pause(); updatePlayIcon(); return; }
    idx = 0;
  }
  playById(pool()[idx].id);
}

function prev() {
  if (!pool().length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (history.length) return playById(history.pop(), { pushHistory: false });
  playById(pool()[(indexOfCurrent() - 1 + pool().length) % pool().length].id, { pushHistory: false });
}

const skip = d => { if (currentId !== null) audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + d)); };

function togglePlay() {
  if (currentId === null) { if (songs.length) playById(songs[0].id); return; }
  audio.paused ? audio.play() : audio.pause();
}
function updatePlayIcon() {
  const playing = !audio.paused && !audio.ended;
  $('ic-play').hidden = playing;
  $('ic-pause').hidden = !playing;
}

$('btn-play').addEventListener('click', togglePlay);
$('btn-next').addEventListener('click', () => next(false));
$('btn-prev').addEventListener('click', prev);
$('btn-back').addEventListener('click', () => skip(-10));
$('btn-fwd').addEventListener('click', () => skip(10));
$('btn-shuffle').addEventListener('click', () => {
  shuffle = !shuffle; queue = [];
  $('btn-shuffle').classList.toggle('on', shuffle);
});
$('btn-repeat').addEventListener('click', () => {
  repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
  $('btn-repeat').classList.toggle('on', repeat !== 'off');
  $('repeat-one').hidden = repeat !== 'one';
});
$('btn-speed').addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  audio.playbackRate = SPEEDS[speedIdx];
  $('btn-speed').textContent = SPEEDS[speedIdx] + 'x';
  $('btn-speed').classList.toggle('on', SPEEDS[speedIdx] !== 1);
});

audio.addEventListener('play', () => { updatePlayIcon(); errorStreak = 0; });
audio.addEventListener('pause', updatePlayIcon);
audio.addEventListener('ended', () => next(true));
audio.addEventListener('error', () => {
  if (currentId === null) return;
  const s = songs.find(x => x.id === currentId);
  showStatus(`เล่นไม่ได้: ${s ? s.name : 'ไฟล์เสียหรือไม่รองรับ'}`, 3000);
  if (++errorStreak < Math.max(songs.length, 1) && songs.length > 1) next(false);
});

/* ============ Sleep timer ============ */
const SLEEP_OPTS = [0, 15, 30, 45, 60];
$('btn-sleep').addEventListener('click', () => {
  const cur = sleepEnd ? Math.round((sleepEnd - Date.now()) / 60000) : 0;
  const nextOpt = SLEEP_OPTS.find(m => m > cur) ?? 0;
  clearTimeout(sleepTimer); sleepTimer = null; sleepEnd = 0;
  if (nextOpt) {
    sleepEnd = Date.now() + nextOpt * 60000;
    sleepTimer = setTimeout(() => { audio.pause(); sleepEnd = 0; paintSleep(); }, nextOpt * 60000);
  }
  paintSleep(nextOpt);
});
function paintSleep(m = 0) {
  $('btn-sleep').textContent = m ? `😴 ${m} นาที` : '😴 ตั้งเวลา';
  $('btn-sleep').classList.toggle('on', !!m);
}

/* ============ Seek bar ============ */
const fmt = t => {
  if (!isFinite(t)) return '0:00';
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
};
function paintSeek() {
  seekEl.style.setProperty('--p', (seekEl.value / (Number(seekEl.max) || 1)) * 100 + '%');
}
audio.addEventListener('loadedmetadata', () => {
  seekEl.max = audio.duration || 100;
  $('dur').textContent = fmt(audio.duration);
});
let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  if (!seeking) { seekEl.value = audio.currentTime; $('cur').textContent = fmt(audio.currentTime); paintSeek(); }
  updatePositionState();
  if (currentId !== null && Date.now() - lastSave > 3000) {
    lastSave = Date.now();
    store.set('last', { id: currentId, t: audio.currentTime });
  }
});
seekEl.addEventListener('input', () => { seeking = true; $('cur').textContent = fmt(Number(seekEl.value)); paintSeek(); });
seekEl.addEventListener('change', () => { audio.currentTime = Number(seekEl.value); seeking = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && currentId !== null) store.set('last', { id: currentId, t: audio.currentTime });
});

/* ============ Lock screen (Media Session) ============ */
function setMediaSession(song, cover) {
  if (!('mediaSession' in navigator)) return;
  const art = cover
    ? [{ src: coverUrl, sizes: '512x512', type: cover.type || 'image/jpeg' }]
    : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.name, artist: song.artist || 'Offline Music', artwork: art
  });
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate
    });
  } catch (e) {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', () => next(false));
  ms.setActionHandler('seekbackward', d => skip(-(d.seekOffset || 10)));
  ms.setActionHandler('seekforward', d => skip(d.seekOffset || 10));
  ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; });
}

/* ============ เพลย์ลิสต์ + โหมดเลือก ============ */
let pls = store.get('pls', []), curPl = '', selectMode = false;
const selected = new Set();
function pool() { const v = visible(); return v.length ? v : songs; }
function renderPls() {
  const box = $('pls'); box.textContent = '';
  for (const n of ['', ...pls]) {
    const b = document.createElement('button');
    b.className = 'chip' + (n === curPl ? ' on' : '');
    b.textContent = n || 'ทั้งหมด';
    b.addEventListener('click', () => { curPl = n; queue = []; selected.clear(); renderLibrary(); updateSelbar(); });
    box.append(b);
  }
  box.hidden = !pls.length;
}
function updateSelbar() {
  $('selbar').hidden = !selectMode;
  $('sel-count').textContent = selected.size + ' เพลง';
  $('btn-unlist').hidden = $('btn-droppl').hidden = !curPl;
  $('btn-select').classList.toggle('on', selectMode);
  $('btn-select').textContent = selectMode ? 'เสร็จ' : 'เลือก';
}
function exitSelect() { selectMode = false; selected.clear(); renderLibrary(); updateSelbar(); }
$('btn-select').addEventListener('click', () => { selectMode ? exitSelect() : (selectMode = true, renderLibrary(), updateSelbar()); });
$('btn-all').addEventListener('click', () => {
  const v = visible();
  if (selected.size === v.length) selected.clear(); else v.forEach(s => selected.add(s.id));
  renderLibrary(); updateSelbar();
});
$('btn-addpl').addEventListener('click', async () => {
  if (!selected.size) return showStatus('เลือกเพลงก่อนนะ', 2000);
  const name = prompt('เพิ่มเข้าเพลย์ลิสต์ (พิมพ์ชื่อใหม่ หรือชื่อที่มีอยู่)\n' + pls.join(', '));
  const n = name && name.trim();
  if (!n) return;
  if (!pls.includes(n)) { pls.push(n); store.set('pls', pls); }
  for (const s of songs.filter(s => selected.has(s.id))) { s.pl = [...new Set([...(s.pl || []), n])]; await dbPutSong(s); }
  showStatus(`เพิ่มใน “${n}” แล้ว`, 2000);
  exitSelect();
});
$('btn-unlist').addEventListener('click', async () => {
  for (const s of songs.filter(s => selected.has(s.id))) { s.pl = (s.pl || []).filter(x => x !== curPl); await dbPutSong(s); }
  exitSelect();
});
$('btn-droppl').addEventListener('click', async () => {
  if (!confirm(`ลบเพลย์ลิสต์ “${curPl}” ? (เพลงจะไม่ถูกลบ)`)) return;
  for (const s of songs.filter(s => (s.pl || []).includes(curPl))) { s.pl = s.pl.filter(x => x !== curPl); await dbPutSong(s); }
  pls = pls.filter(x => x !== curPl); store.set('pls', pls); curPl = '';
  exitSelect();
});
$('btn-delsel').addEventListener('click', async () => {
  if (!selected.size) return showStatus('เลือกเพลงก่อนนะ', 2000);
  if (!confirm(`ลบ ${selected.size} เพลง ?`)) return;
  for (const s of songs.filter(s => selected.has(s.id))) await removeSong(s, false);
  exitSelect();
});

/* ============ Init ============ */
(async function init() {
  try {
    db = await openDB();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    await refreshLibrary();
    const last = store.get('last', null);   // กลับมาที่เพลง/ตำแหน่งเดิม (ไม่เล่นเอง)
    if (last && songs.some(s => s.id === last.id)) await playById(last.id, { pushHistory: false, startAt: last.t, autoplay: false });
  } catch (e) {
    showStatus('เปิดฐานข้อมูลไม่ได้: ' + (e && e.message ? e.message : e));
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
})();
