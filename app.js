'use strict';

/* ============ IndexedDB ============
 * แยกเก็บ 2 store:
 *  - songs : metadata (id, name, size, added)  -> เบา โหลดทำรายการได้เร็ว
 *  - files : { id, blob }                      -> ไฟล์เสียงจริง ดึงมาเฉพาะตอนจะเล่น
 */
const DB_NAME = 'offline-music';
const DB_VERSION = 1;
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

const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});
const reqDone = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function dbAddSong(file) {
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  const meta = { name: file.name.replace(/\.[^.]+$/, ''), size: file.size, added: Date.now() };
  const addReq = tx.objectStore('songs').add(meta);
  addReq.onsuccess = () => tx.objectStore('files').put({ id: addReq.result, blob: file });
  await txDone(tx);
}
const dbGetAllSongs = () => reqDone(db.transaction('songs').objectStore('songs').getAll());
const dbGetFile = async id => (await reqDone(db.transaction('files').objectStore('files').get(id)))?.blob;
async function dbDeleteSong(id) {
  const tx = db.transaction(['songs', 'files'], 'readwrite');
  tx.objectStore('songs').delete(id);
  tx.objectStore('files').delete(id);
  await txDone(tx);
}

/* ============ State & elements ============ */
const $ = id => document.getElementById(id);
const audio = $('audio');
const listEl = $('library');
const emptyEl = $('empty');
const statusEl = $('status');
const seekEl = $('seek');

let songs = [];          // รายการเพลง (metadata)
let currentId = null;
let currentUrl = null;
let shuffle = false;
let repeat = 'off';      // off | all | one
let history = [];        // ประวัติเพลงที่เล่นผ่านมา (ใช้กับปุ่ม Previous ตอน Shuffle)
let seeking = false;

/* ============ Library ============ */
async function refreshLibrary() {
  songs = (await dbGetAllSongs()).sort((a, b) => a.added - b.added || a.name.localeCompare(b.name));
  renderLibrary();
}

function renderLibrary() {
  listEl.textContent = '';
  emptyEl.hidden = songs.length > 0;
  for (const s of songs) {
    const li = document.createElement('li');
    li.className = 'track' + (s.id === currentId ? ' active' : '');
    li.dataset.id = s.id;

    const main = document.createElement('button');
    main.className = 'track-main';
    const name = document.createElement('div');
    name.className = 'track-name';
    name.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'track-meta';
    meta.textContent = (s.size / 1048576).toFixed(1) + ' MB';
    main.append(name, meta);
    main.addEventListener('click', () => playById(s.id));

    const del = document.createElement('button');
    del.className = 'del';
    del.setAttribute('aria-label', 'ลบเพลง');
    del.textContent = '✕';
    del.addEventListener('click', () => removeSong(s));

    li.append(main, del);
    listEl.append(li);
  }
}

function showStatus(msg) {
  statusEl.textContent = msg;
  statusEl.hidden = !msg;
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
        ? 'พื้นที่เก็บข้อมูลเต็ม ไม่สามารถบันทึกเพิ่มได้'
        : 'บันทึกไม่สำเร็จ: ' + f.name);
      await refreshLibrary();
      return;
    }
  }
  showStatus(ok ? `เพิ่มแล้ว ${ok} เพลง` : '');
  setTimeout(() => showStatus(''), 2500);
  await refreshLibrary();
});

async function removeSong(s) {
  if (!confirm(`ลบ “${s.name}” ?`)) return;
  if (s.id === currentId) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    currentId = null;
    $('now-title').textContent = 'ยังไม่ได้เลือกเพลง';
    updatePlayIcon();
  }
  history = history.filter(id => id !== s.id);
  await dbDeleteSong(s.id);
  await refreshLibrary();
}

/* ============ Playback ============ */
async function playById(id, pushHistory = true) {
  const song = songs.find(s => s.id === id);
  const blob = await dbGetFile(id);
  if (!song || !blob) return;

  if (pushHistory && currentId !== null && currentId !== id) history.push(currentId);
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  currentId = id;
  audio.src = currentUrl;

  $('now-title').textContent = song.name;
  renderLibrary();
  setMediaSession(song);
  try { await audio.play(); } catch (e) { /* รอผู้ใช้กดเล่น */ }
}

function indexOfCurrent() { return songs.findIndex(s => s.id === currentId); }

function next(auto = false) {
  if (!songs.length) return;
  if (auto && repeat === 'one') { audio.currentTime = 0; audio.play(); return; }

  let idx = indexOfCurrent();
  if (shuffle && songs.length > 1) {
    let r;
    do { r = Math.floor(Math.random() * songs.length); } while (r === idx);
    return playById(songs[r].id);
  }
  idx += 1;
  if (idx >= songs.length) {
    if (auto && repeat === 'off') { audio.pause(); updatePlayIcon(); return; }
    idx = 0;
  }
  playById(songs[idx].id);
}

function prev() {
  if (!songs.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (history.length) return playById(history.pop(), false);
  const idx = indexOfCurrent();
  playById(songs[(idx - 1 + songs.length) % songs.length].id, false);
}

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
$('btn-shuffle').addEventListener('click', () => {
  shuffle = !shuffle;
  $('btn-shuffle').classList.toggle('on', shuffle);
});
$('btn-repeat').addEventListener('click', () => {
  repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
  $('btn-repeat').classList.toggle('on', repeat !== 'off');
  $('repeat-one').hidden = repeat !== 'one';
});

audio.addEventListener('play', updatePlayIcon);
audio.addEventListener('pause', updatePlayIcon);
audio.addEventListener('ended', () => next(true));

/* ============ Seek bar ============ */
const fmt = t => {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
function paintSeek() {
  const max = Number(seekEl.max) || 1;
  seekEl.style.setProperty('--p', (seekEl.value / max) * 100 + '%');
}
audio.addEventListener('loadedmetadata', () => {
  seekEl.max = audio.duration || 100;
  $('dur').textContent = fmt(audio.duration);
});
audio.addEventListener('timeupdate', () => {
  if (!seeking) { seekEl.value = audio.currentTime; $('cur').textContent = fmt(audio.currentTime); paintSeek(); }
  updatePositionState();
});
seekEl.addEventListener('input', () => {
  seeking = true;
  $('cur').textContent = fmt(Number(seekEl.value));
  paintSeek();
});
seekEl.addEventListener('change', () => {
  audio.currentTime = Number(seekEl.value);
  seeking = false;
});

/* ============ Lock screen controls (Media Session) ============ */
function setMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.name,
    artist: 'Offline Music',
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
  });
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate
    });
  } catch (e) {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', () => next(false));
  ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; });
}

/* ============ Init ============ */
(async function init() {
  try {
    db = await openDB();
    // ขอให้เบราว์เซอร์ไม่ลบข้อมูลอัตโนมัติ
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    await refreshLibrary();
  } catch (e) {
    showStatus('เปิดฐานข้อมูลไม่ได้: ' + (e && e.message ? e.message : e));
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
