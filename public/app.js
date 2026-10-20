import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);

let files = [];
let worker = null;
let results = [];   // { name, blob, url }
let backendLabel = '';

if (!window.isSecureContext) {
  $('insecure').hidden = false;
  $('https-link').href = `https://${location.host}${location.pathname}`;
}

function showOnly(...ids) {
  for (const s of ['pick', 'work', 'results', 'error']) $(s).hidden = !ids.includes(s);
}

const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);
const mo = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function setFiles(list) {
  files = [...list].filter(f => isImage(f) || f.type.startsWith('video/') || /\.(mkv|mov|avi|mts|m2ts|webm|mp4|m4v)$/i.test(f.name));
  if (!files.length) return;
  const size = files.reduce((s, f) => s + f.size, 0);
  $('drop-title').textContent = files.length === 1 ? files[0].name : plural(files.length, 'fichier');
  const videos = files.filter(f => !isImage(f)).length, photos = files.length - videos;
  const kinds = [videos && plural(videos, 'vidéo'), photos && plural(photos, 'photo')].filter(Boolean).join(', ');
  $('drop-sub').textContent = `${files.length > 1 ? kinds + ' · ' : ''}${mo(size)} · cliquer pour changer`;
  $('start').disabled = false;
}

$('file').addEventListener('change', (e) => setFiles(e.target.files));
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  setFiles(e.dataTransfer.files);
});

const bindOut = (input, out, fmt) => {
  const update = () => { $(out).textContent = fmt(+$(input).value); };
  $(input).addEventListener('input', update);
  update();
};
bindOut('threshold', 'threshold-out', v => v.toFixed(2));
bindOut('mask', 'mask-out', v => `${v.toFixed(2)}×`);
bindOut('mosaic', 'mosaic-out', v => `${v} px`);
$('replacewith').addEventListener('change', () => {
  const m = $('replacewith').value;
  $('mosaic-row').hidden = m !== 'mosaic';
  $('shape').disabled = m !== 'blur';
});

// Each mode also presets the related settings, which stay adjustable.
const PRESETS = {
  fast: { threshold: 0.2, mask: 1.3, maxside: '1280' },
  precise: { threshold: 0.2, mask: 1.3, maxside: '1280' },
  thorough: { threshold: 0.15, mask: 1.4, maxside: '0' },
};
for (const radio of document.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    const p = PRESETS[radio.value];
    $('threshold').value = p.threshold;
    $('mask').value = p.mask;
    $('maxside').value = p.maxside;
    for (const id of ['threshold', 'mask']) $(id).dispatchEvent(new Event('input'));
  });
}

function fmtTime(s) {
  if (!isFinite(s)) return '…';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(sec).padStart(2, '0')} s` : `${sec} s`;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  window.onbeforeunload = null;
}

function clearResults() {
  results.forEach(r => URL.revokeObjectURL(r.url));
  results = [];
  $('result-list').replaceChildren();
}

function outputName(file, blob) {
  const base = file.name.replace(/\.[^.]+$/, '');
  const ext = { 'video/mp4': 'mp4', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[blob.type] ?? 'bin';
  return `${base}_floute.${ext}`;
}

function addResult(file, data) {
  const url = URL.createObjectURL(data.blob);
  const name = outputName(file, data.blob);
  results.push({ name, blob: data.blob, url });

  const li = $('result-tpl').content.firstElementChild.cloneNode(true);
  const media = document.createElement(data.blob.type.startsWith('video/') ? 'video' : 'img');
  media.src = url;
  if (media.tagName === 'VIDEO') { media.controls = true; media.playsInline = true; media.preload = 'metadata'; }
  else media.alt = `${file.name} floutée`;
  li.querySelector('.media').append(media);
  li.querySelector('.name').textContent = file.name;
  const notes = data.frames > 1
    ? [`${data.frames} images en ${fmtTime(data.elapsed)}`, `visages sur ${plural(data.framesWithFaces, 'image')}`]
    : [data.faces ? `${plural(data.faces, 'visage')} flouté${data.faces > 1 ? 's' : ''}` : 'aucun visage détecté'];
  notes.push(mo(data.blob.size));
  if (data.hadAudio && !data.audioKept) notes.push('sans le son');
  li.querySelector('.summary').textContent = notes.join(' · ');
  const a = li.querySelector('.download');
  a.href = url;
  a.download = name;
  $('result-list').append(li);
}

function addFailure(file, message) {
  const li = $('result-tpl').content.firstElementChild.cloneNode(true);
  li.classList.add('error');
  li.querySelector('.media').remove();
  li.querySelector('.name').textContent = file.name;
  li.querySelector('.summary').textContent = `Échec : ${message}`;
  li.querySelector('.download').remove();
  $('result-list').append(li);
}

$('start').addEventListener('click', () => {
  if (!files.length) return;
  const options = {
    replacewith: $('replacewith').value,
    ellipse: $('shape').value === 'ellipse',
    threshold: +$('threshold').value,
    maskScale: +$('mask').value,
    mosaicSize: +$('mosaic').value,
    maxSide: +$('maxside').value,
    quality: $('quality').value,
    accel: $('accel').value,
    mode: document.querySelector('input[name=mode]:checked').value,
    keepAudio: $('audio').checked,
    // CPU detection: leave a core for decoding/encoding; each detector holds its own copy of the model.
    workers: Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1)),
  };
  clearResults();
  showOnly('work');
  $('status').textContent = 'Préparation…';
  $('current').textContent = '';
  $('stats').textContent = '';
  $('bar').removeAttribute('value');
  const canvas = $('preview');
  canvas.width = canvas.height = 0;

  const items = files.map((file, id) => ({ id, file }));
  let finished = 0;
  window.onbeforeunload = (e) => { e.preventDefault(); return ''; };
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const file = files[data.id];
    switch (data.type) {
      case 'backend':
        backendLabel = data.backend === 'webgpu' ? 'Détection sur la carte graphique (WebGPU).' : `Détection sur le processeur (${data.size} cœurs).`;
        $('engine').textContent = backendLabel;
        break;
      case 'status':
        $('status').textContent = data.text;
        break;
      case 'item-start':
        $('status').textContent = data.kind === 'image' ? 'Floutage des photos…' : 'Préparation de la vidéo…';
        $('current').textContent = files.length > 1 ? `Fichier ${finished + 1} / ${files.length} : ${file.name}` : file.name;
        if (data.kind === 'video') $('bar').removeAttribute('value');
        break;
      case 'progress': {
        const rate = data.done / data.elapsed;
        const parts = [`Image ${data.done}${data.total ? ` / ${data.total}` : ''}`, `${rate.toFixed(1)} im/s`];
        if (data.total) {
          $('bar').max = data.total;
          $('bar').value = Math.min(data.done, data.total);
          parts.push(`reste ~${fmtTime((data.total - data.done) / rate)}`);
        }
        $('stats').textContent = parts.join(' · ');
        break;
      }
      case 'preview': {
        const bmp = data.bitmap;
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        break;
      }
      case 'item-done':
      case 'item-error':
        finished++;
        if (data.type === 'item-done') addResult(file, data);
        else addFailure(file, data.message);
        if (files.length > 1) {
          $('bar').max = files.length;
          $('bar').value = finished;
          $('stats').textContent = `${finished} / ${files.length} fichiers traités`;
        }
        break;
      case 'all-done':
        stopWorker();
        $('zip').hidden = results.length < 2;
        showOnly('results');
        break;
      case 'fatal':
        stopWorker();
        $('error-msg').textContent = data.message;
        showOnly('error');
        break;
    }
  };
  worker.onerror = (e) => {
    stopWorker();
    $('error-msg').textContent = e.message || 'Erreur inattendue dans le navigateur.';
    showOnly('error');
  };
  worker.postMessage({ type: 'start', items, options });
});

$('zip').addEventListener('click', async () => {
  $('zip').disabled = true;
  try {
    const zip = await makeZip(results);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = 'visages_floutes.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } finally {
    $('zip').disabled = false;
  }
});

$('cancel').addEventListener('click', () => {
  stopWorker();
  $('zip').hidden = results.length < 2;
  showOnly(...(results.length ? ['pick', 'results'] : ['pick']));
});
$('again').addEventListener('click', () => { clearResults(); showOnly('pick'); });
$('retry').addEventListener('click', () => showOnly('pick'));
