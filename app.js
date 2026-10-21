const $ = (id) => document.getElementById(id);

const drop = $('drop');
const fileInput = $('fileInput');
const stage = $('stage');
const actionsBar = $('actions');
const area = $('area');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const sel = $('sel');
const loading = $('loading');
const blockSize = $('blockSize');
const blockOut = $('blockOut');
const undoBtn = $('undoBtn');
const downloadBtn = $('downloadBtn');
const toast = $('toast');
const dropOverlay = $('dropOverlay');
const pixelOpts = $('pixelOpts');
const colorOpts = $('colorOpts');
const signOpts = $('signOpts');
const sigList = $('sigList');
const hint = $('hint');
const pager = $('pager');
const pageLabel = $('pageLabel');
const prevPage = $('prevPage');
const nextPage = $('nextPage');

// A document is a list of pages: one for a screenshot, one per page for a PDF.
// Each page is { w, h, base, actions } where w/h are canvas pixels and base is the
// rendered page (PDF pages render the first time they're shown). PDF pages also
// keep their size in points (ptW, ptH) and the render scale.
let doc = null;          // { kind: 'image' | 'pdf', name, pages, pdf?, bytes? }
let current = 0;         // page on screen
let history = [];        // page index of every action, newest last (Undo across pages)
let version = 0;         // bumps whenever any page's actions change
let drag = null;         // { x0, y0, x1, y1, shift } while dragging
let tool = 'pixelate';   // pixelate | rect | ellipse | line | arrow | sign
let color = '#ef4444';
let signature = null;    // data URL of the signature the Sign tool places

const page = () => doc.pages[current];

// Phones and tablets: no keyboard shortcuts, no drag & drop, save through the share sheet.
const isTouch = matchMedia('(pointer: coarse)').matches;

// Show ⌘ on Apple devices and Ctrl+ everywhere else.
const isMac = /mac|iphone|ipad/i.test(
  navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
);
const MOD = isMac ? '⌘' : 'Ctrl+';
document.querySelectorAll('.mod').forEach((el) => (el.textContent = MOD));
undoBtn.title = `Undo (${MOD}Z)`;

if (isTouch) {
  $('dropTitle').textContent = 'Choose a screenshot or PDF';
  $('dropSub').textContent = 'Tap anywhere here to pick a file';
  downloadBtn.textContent = 'Save';
}

// [what the tool does, what Shift adds]
const HINTS = {
  pixelate: ['Drag across anything sensitive to pixelate it', ''],
  rect: ['Drag to draw a box', 'hold Shift for a square'],
  ellipse: ['Drag to draw a circle', 'hold Shift for a perfect circle'],
  line: ['Drag to draw a line', 'hold Shift to snap the angle'],
  arrow: ['Drag from tail to tip', 'hold Shift to snap the angle'],
  sign: ['Drag a box where your signature goes, or click to drop it', ''],
};

function hintFor(t) {
  const [base, shift] = HINTS[t];
  if (isTouch) return base.replace('Drag', 'Drag your finger').replace('click', 'tap');
  return [base, shift, `${MOD}V or drop to open another file`].filter(Boolean).join(' · ');
}

// ---------- Loading ----------

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const isOpenable = (f) => f && (f.type.startsWith('image/') || isPdf(f));

function baseName(file) {
  // Clipboard images come through as a generic "image.png"; give them a useful name.
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  return generic
    ? `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    : file.name.replace(/\.[^.]+$/, '');
}

async function loadFile(file, source) {
  if (!isOpenable(file)) {
    showToast('Open an image or a PDF');
    return;
  }
  try {
    if (isPdf(file)) showToast('Opening PDF…');
    const next = isPdf(file) ? await openPdf(file) : await openImage(file);
    next.name = baseName(file);
    doc = next;
    history = [];
    drop.hidden = true;
    stage.hidden = false;
    actionsBar.hidden = false;
    await showPage(0);
    changed();
    if (source) showToast(source);
    else if (isPdf(file)) toast.hidden = true;
  } catch (err) {
    showToast(
      err?.name === 'PasswordException'
        ? 'Password-protected PDFs aren’t supported'
        : `Couldn’t open that ${isPdf(file) ? 'PDF' : 'image'}`
    );
  }
}

function openImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ kind: 'image', pages: [{ w: img.naturalWidth, h: img.naturalHeight, base: img, actions: [] }] });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Not a readable image'));
    };
    img.src = url;
  });
}

// PDF.js (reading) and pdf-lib (writing) only load the first time they're needed.
const scripts = {};
function loadScript(src) {
  return (scripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn’t load ${src}`));
    document.head.append(s);
  }));
}

async function loadPdfJs() {
  await loadScript('vendor/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return pdfjsLib;
}

const PDF_SCALE = 2;    // render at 144 dpi: sharp text, still light enough to pixelate
const MAX_SIDE = 2600;  // keep oversized pages (posters, drawings) manageable

async function openPdf(file) {
  const pdfjs = await loadPdfJs();
  const bytes = await file.arrayBuffer();
  // PDF.js takes ownership of the buffer it's given; keep our own copy for export.
  const pdf = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
    const scale = Math.min(PDF_SCALE, MAX_SIDE / Math.max(vp.width, vp.height));
    pages.push({
      w: Math.round(vp.width * scale),
      h: Math.round(vp.height * scale),
      scale,
      ptW: vp.width,
      ptH: vp.height,
      base: null,
      actions: [],
    });
  }
  return { kind: 'pdf', pdf, bytes, pages };
}

// Resolves to the page's rendered base, rendering a PDF page once on first use.
function ensureBase(i) {
  const p = doc.pages[i];
  if (p.base) return Promise.resolve(p.base);
  return (p.ready ||= (async () => {
    const pdfPage = await doc.pdf.getPage(i + 1);
    const c = document.createElement('canvas');
    c.width = p.w;
    c.height = p.h;
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, c.width, c.height);
    await pdfPage.render({ canvasContext: cx, viewport: pdfPage.getViewport({ scale: p.scale }) }).promise;
    p.base = c;
    return c;
  })());
}

async function showPage(i) {
  current = i;
  const p = page();
  canvas.width = p.w;
  canvas.height = p.h;
  fitCanvas();
  updatePager();
  loading.hidden = !!p.base;
  if (!p.base) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await ensureBase(i);
    if (current !== i) return; // moved to another page while this one rendered
    loading.hidden = true;
  }
  render();
}

function updatePager() {
  const n = doc.pages.length;
  pager.hidden = n < 2;
  pageLabel.textContent = `Page ${current + 1} of ${n}`;
  prevPage.disabled = current === 0;
  nextPage.disabled = current === n - 1;
}

function goPage(step) {
  const i = current + step;
  if (doc && !drag && i >= 0 && i < doc.pages.length) showPage(i);
}
prevPage.addEventListener('click', () => goPage(-1));
nextPage.addEventListener('click', () => goPage(1));

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  loadFile(fileInput.files[0]);
  fileInput.value = '';
});

// Drag & drop works anywhere on the page, before or after a file is open.
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;

function setDropping(on) {
  drop.classList.toggle('over', on && !drop.hidden);
  dropOverlay.hidden = !(on && drop.hidden);
}

document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  setDropping(true);
});
document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropping(false);
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDropping(false);
  const file = [...e.dataTransfer.files].find(isOpenable);
  loadFile(file || e.dataTransfer.files[0], doc ? 'Opened' : null);
});

// ⌘V / Ctrl+V pastes a screenshot from the clipboard (or an image/PDF copied in Finder).
document.addEventListener('paste', (e) => {
  if (sigDialog.open) return; // let people paste their name into the signature box
  const files = [
    ...[...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()),
    ...e.clipboardData.files,
  ];
  const file = files.find(isOpenable);
  if (!file) {
    showToast('No image on the clipboard');
    return;
  }
  e.preventDefault();
  loadFile(file, doc ? 'Pasted' : null);
});

// ---------- Layout ----------

// Shrink the canvas to fit the space left under the toolbar (never enlarge it).
function fitCanvas() {
  if (!doc) return;
  const s = Math.min(area.clientWidth / canvas.width, area.clientHeight / canvas.height, 1);
  canvas.style.width = Math.floor(canvas.width * s) + 'px';
  canvas.style.height = Math.floor(canvas.height * s) + 'px';
}
new ResizeObserver(fitCanvas).observe(area);

// ---------- Rendering ----------

// Scale sizes with the page so tools feel the same on any resolution.
const imageScale = () => Math.max(1, Math.max(canvas.width, canvas.height) / 1400);
const blockFor = (value) => Math.round(value * imageScale());
const strokeWidth = () => Math.round(5 * imageScale());

function pixelate(c, r) {
  const x = Math.round(r.x), y = Math.round(r.y);
  const w = Math.round(r.w), h = Math.round(r.h);
  if (w < 1 || h < 1) return;

  // Average every pixel in each block so no detail leaks through.
  const b = r.block;
  const data = c.getImageData(x, y, w, h);
  const px = data.data;
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      const ex = Math.min(bx + b, w), ey = Math.min(by + b, h);
      let rs = 0, gs = 0, bs = 0, as = 0, n = 0;
      for (let yy = by; yy < ey; yy++) {
        for (let xx = bx; xx < ex; xx++) {
          const i = (yy * w + xx) * 4;
          rs += px[i]; gs += px[i + 1]; bs += px[i + 2]; as += px[i + 3]; n++;
        }
      }
      rs /= n; gs /= n; bs /= n; as /= n;
      for (let yy = by; yy < ey; yy++) {
        for (let xx = bx; xx < ex; xx++) {
          const i = (yy * w + xx) * 4;
          px[i] = rs; px[i + 1] = gs; px[i + 2] = bs; px[i + 3] = as;
        }
      }
    }
  }
  c.putImageData(data, x, y);
}

function drawShape(c, a) {
  const { x0, y0, x1, y1 } = a;
  c.save();
  c.strokeStyle = a.color;
  c.fillStyle = a.color;
  c.lineWidth = a.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();

  if (a.type === 'rect') {
    c.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    c.stroke();
  } else if (a.type === 'ellipse') {
    c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    c.stroke();
  } else if (a.type === 'line') {
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  } else if (a.type === 'arrow') {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const head = Math.min(len * 0.6, a.width * 4.5);
    const spread = 0.45;
    // Stop the shaft inside the head so the tip stays sharp.
    c.moveTo(x0, y0);
    c.lineTo(x1 - Math.cos(ang) * head * 0.8, y1 - Math.sin(ang) * head * 0.8);
    c.stroke();
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x1 - head * Math.cos(ang - spread), y1 - head * Math.sin(ang - spread));
    c.lineTo(x1 - head * Math.cos(ang + spread), y1 - head * Math.sin(ang + spread));
    c.closePath();
    c.fill();
    c.stroke();
  }
  c.restore();
}

// Signature images, decoded once and shared by every placement.
const sigImages = new Map();
function sigImage(src) {
  let img = sigImages.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => render();
    img.src = src;
    sigImages.set(src, img);
  }
  return img;
}

function draw(c, a) {
  if (a.type === 'pixelate') pixelate(c, a);
  else if (a.type === 'sign') {
    const img = sigImage(a.src);
    if (img.complete && img.naturalWidth) c.drawImage(img, a.x, a.y, a.w, a.h);
  } else drawShape(c, a);
}

function render() {
  if (!doc || !page().base) return;
  const p = page();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(p.base, 0, 0, canvas.width, canvas.height);
  p.actions.forEach((a) => draw(ctx, a));
  if (drag) draw(ctx, currentAction());
  undoBtn.disabled = history.length === 0;
}

// Call after every change to a page's actions.
function changed() {
  version++;
  render();
  prepareShare();
}

// ---------- Crosshair drag ----------

function toImage(e) {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  return {
    x: Math.min(Math.max(x, 0), canvas.width),
    y: Math.min(Math.max(y, 0), canvas.height),
  };
}

const dragBox = () => ({
  x: Math.min(drag.x0, drag.x1),
  y: Math.min(drag.y0, drag.y1),
  w: Math.abs(drag.x1 - drag.x0),
  h: Math.abs(drag.y1 - drag.y0),
});

// Places the signature inside the dragged box, keeping its shape.
// A click (or a tiny drag) drops it at a comfortable default size instead.
function signAction() {
  const img = sigImage(signature);
  const ratio = img.naturalWidth / img.naturalHeight || 3;
  const box = dragBox();
  const pxPerCss = canvas.width / canvas.getBoundingClientRect().width;
  if (box.w < 10 * pxPerCss && box.h < 10 * pxPerCss) {
    const w = canvas.width * 0.28, h = w / ratio;
    return { type: 'sign', src: signature, x: drag.x0 - w / 2, y: drag.y0 - h / 2, w, h };
  }
  if (box.w / box.h > ratio) {
    const w = box.h * ratio;
    return { type: 'sign', src: signature, x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h };
  }
  const h = box.w / ratio;
  return { type: 'sign', src: signature, x: box.x, y: box.y + (box.h - h) / 2, w: box.w, h };
}

// Turns the drag into an action, applying Shift constraints.
function currentAction() {
  if (tool === 'sign') return signAction();

  const { x0, y0, shift } = drag;
  let { x1, y1 } = drag;
  const dx = x1 - x0, dy = y1 - y0;

  if (shift && (tool === 'line' || tool === 'arrow')) {
    const len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    x1 = x0 + Math.cos(ang) * len;
    y1 = y0 + Math.sin(ang) * len;
  } else if (shift) {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    x1 = x0 + Math.sign(dx || 1) * d;
    y1 = y0 + Math.sign(dy || 1) * d;
  }

  if (tool === 'pixelate') {
    return {
      type: 'pixelate',
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
      block: blockFor(+blockSize.value),
    };
  }
  return { type: tool, x0, y0, x1, y1, color, width: strokeWidth() };
}

function isMeaningful(a) {
  if (a.type === 'sign') return true;
  if (a.type === 'pixelate') return a.w > 2 && a.h > 2;
  return Math.hypot(a.x1 - a.x0, a.y1 - a.y0) > 3;
}

function showSelection() {
  if (tool !== 'pixelate' && tool !== 'sign') return;
  const r = tool === 'pixelate' ? currentAction() : dragBox();
  const k = canvas.getBoundingClientRect().width / canvas.width;
  sel.style.left = r.x * k + 'px';
  sel.style.top = r.y * k + 'px';
  sel.style.width = r.w * k + 'px';
  sel.style.height = r.h * k + 'px';
  sel.hidden = r.w * k < 4 && r.h * k < 4;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drag || !doc || !page().base) return;
  if (tool === 'sign' && !signature) {
    openSigDialog();
    return;
  }
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Not fatal: the drag still works while the finger stays on the page.
  }
  const p = toImage(e);
  drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey };
  showSelection();
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = toImage(e);
  drag.x1 = p.x;
  drag.y1 = p.y;
  drag.shift = e.shiftKey;
  showSelection();
  render();
});

function endDrag() {
  if (!drag) return;
  const a = currentAction();
  drag = null;
  sel.hidden = true;
  if (isMeaningful(a)) {
    page().actions.push(a);
    history.push(current);
  }
  changed();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- Tools & colours ----------

function setTool(t) {
  tool = t;
  document.querySelectorAll('#toolSeg .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  pixelOpts.hidden = t !== 'pixelate';
  colorOpts.hidden = t === 'pixelate' || t === 'sign';
  signOpts.hidden = t !== 'sign';
  hint.textContent = hintFor(t);
  if (t === 'sign' && !signature) openSigDialog();
}

function setColor(c) {
  color = c;
  document.querySelectorAll('#colorOpts .swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === c));
}

hint.textContent = hintFor(tool);
document.querySelectorAll('#toolSeg .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('#colorOpts .swatch').forEach((s) => s.addEventListener('click', () => setColor(s.dataset.color)));

const TOOL_KEYS = { p: 'pixelate', b: 'rect', r: 'rect', o: 'ellipse', c: 'ellipse', l: 'line', a: 'arrow', s: 'sign' };
const swatchColors = [...document.querySelectorAll('#colorOpts .swatch')].map((s) => s.dataset.color);

// ---------- Signatures ----------

// Saved signatures live only in this browser (localStorage), newest first.
const SIG_KEY = 'blur.signatures';
const MAX_SAVED = 6;
let sigs = loadSavedSigs().map((src) => ({ src, saved: true }));
signature = sigs[0]?.src || null;

function loadSavedSigs() {
  try {
    const list = JSON.parse(localStorage.getItem(SIG_KEY));
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.startsWith('data:image/png')) : [];
  } catch {
    return [];
  }
}

function storeSigs() {
  try {
    localStorage.setItem(SIG_KEY, JSON.stringify(sigs.filter((s) => s.saved).map((s) => s.src)));
  } catch {
    showToast('This browser won’t let me save the signature');
  }
}

function renderSigList() {
  sigList.replaceChildren(
    ...sigs.map((s) => {
      const thumb = document.createElement('div');
      thumb.className = 'sig-thumb' + (s.src === signature ? ' active' : '');
      thumb.setAttribute('role', 'button');
      thumb.tabIndex = 0;
      thumb.title = s.saved ? 'Saved signature' : 'Signature (not saved)';
      thumb.addEventListener('click', () => {
        signature = s.src;
        renderSigList();
      });

      const img = new Image();
      img.src = s.src;
      img.alt = 'Signature';

      const del = document.createElement('button');
      del.className = 'sig-del';
      del.textContent = '×';
      del.title = 'Delete signature';
      del.setAttribute('aria-label', 'Delete signature');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (s.saved && !confirm('Delete this saved signature?')) return;
        sigs = sigs.filter((x) => x !== s);
        if (signature === s.src) signature = sigs[0]?.src || null;
        storeSigs();
        renderSigList();
      });

      thumb.append(img, del);
      return thumb;
    })
  );
}
renderSigList();

function addSignature(src, remember) {
  sigs = [{ src, saved: remember }, ...sigs.filter((s) => s.src !== src)];
  // Keep at most MAX_SAVED saved ones; drop the oldest.
  let kept = 0;
  sigs = sigs.filter((s) => !s.saved || ++kept <= MAX_SAVED);
  if (remember) storeSigs();
  signature = src;
  renderSigList();
  if (tool !== 'sign') setTool('sign');
  showToast(remember ? 'Signature saved. Click where it goes' : 'Click where your signature goes');
}

$('newSigBtn').addEventListener('click', openSigDialog);

// ----- Signature dialog: draw with mouse/finger, or type -----

const sigDialog = $('sigDialog');
const sigPad = $('sigPad');
const padCtx = sigPad.getContext('2d');
const padHint = $('padHint');
const sigText = $('sigText');
const typePreview = $('typePreview');
let sigMode = 'draw';
let ink = '#111111';
let strokes = [];        // each stroke is a list of {x, y} in CSS pixels
let padDrawing = false;
const SCRIPT_FONT = getComputedStyle(document.documentElement).getPropertyValue('--script').trim();

function openSigDialog() {
  strokes = [];
  sigText.value = '';
  $('sigRemember').checked = true;
  padHint.textContent = 'Sign here';
  padHint.style.color = '';
  setSigMode(sigMode);
  sigDialog.showModal();
  requestAnimationFrame(sizePad);
}

function setSigMode(m) {
  sigMode = m;
  sigDialog.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('drawPane').hidden = m !== 'draw';
  $('typePane').hidden = m !== 'type';
  if (m === 'draw') requestAnimationFrame(sizePad);
  else {
    updateTypePreview();
    sigText.focus();
  }
}
sigDialog.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setSigMode(b.dataset.mode)));

sigDialog.querySelectorAll('[data-ink]').forEach((b) =>
  b.addEventListener('click', () => {
    ink = b.dataset.ink;
    sigDialog.querySelectorAll('[data-ink]').forEach((x) => x.classList.toggle('active', x === b));
    drawPad();
    updateTypePreview();
  })
);

function sizePad() {
  const dpr = window.devicePixelRatio || 1;
  sigPad.width = Math.round(sigPad.clientWidth * dpr);
  sigPad.height = Math.round(sigPad.clientHeight * dpr);
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPad();
}

// Smooth strokes by curving through the midpoints between samples.
function traceStrokes(c, list, width) {
  c.strokeStyle = ink;
  c.fillStyle = ink;
  c.lineWidth = width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const s of list) {
    if (s.length === 1) {
      c.beginPath();
      c.arc(s[0].x, s[0].y, width / 2, 0, Math.PI * 2);
      c.fill();
      continue;
    }
    c.beginPath();
    c.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length - 1; i++) {
      const mx = (s[i].x + s[i + 1].x) / 2, my = (s[i].y + s[i + 1].y) / 2;
      c.quadraticCurveTo(s[i].x, s[i].y, mx, my);
    }
    const last = s[s.length - 1];
    c.lineTo(last.x, last.y);
    c.stroke();
  }
}

const PEN = 2.6;
function drawPad() {
  padCtx.clearRect(0, 0, sigPad.clientWidth, sigPad.clientHeight);
  traceStrokes(padCtx, strokes, PEN);
  padHint.hidden = strokes.length > 0;
}

const padPoint = (e) => {
  const r = sigPad.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
sigPad.addEventListener('pointerdown', (e) => {
  try {
    sigPad.setPointerCapture(e.pointerId);
  } catch {}
  padDrawing = true;
  strokes.push([padPoint(e)]);
  drawPad();
});
sigPad.addEventListener('pointermove', (e) => {
  if (!padDrawing) return;
  strokes[strokes.length - 1].push(padPoint(e));
  drawPad();
});
['pointerup', 'pointercancel'].forEach((t) => sigPad.addEventListener(t, () => (padDrawing = false)));

$('sigClear').addEventListener('click', () => {
  strokes = [];
  drawPad();
});

function updateTypePreview() {
  typePreview.textContent = sigText.value || 'Your name';
  typePreview.style.color = sigText.value ? ink : '#c8d4ea';
}
sigText.addEventListener('input', updateTypePreview);

// Renders the signature onto a tightly-cropped transparent PNG at high resolution.
async function signaturePng() {
  const S = 3, PAD = 6;
  const out = document.createElement('canvas');
  const c = out.getContext('2d');

  if (sigMode === 'draw') {
    const pts = strokes.flat();
    const minX = Math.min(...pts.map((p) => p.x)) - PAD, maxX = Math.max(...pts.map((p) => p.x)) + PAD;
    const minY = Math.min(...pts.map((p) => p.y)) - PAD, maxY = Math.max(...pts.map((p) => p.y)) + PAD;
    out.width = Math.ceil((maxX - minX) * S);
    out.height = Math.ceil((maxY - minY) * S);
    c.scale(S, S);
    c.translate(-minX, -minY);
    traceStrokes(c, strokes, PEN);
  } else {
    const font = `64px ${SCRIPT_FONT}`;
    await document.fonts.load(font).catch(() => {});
    c.font = font;
    const m = c.measureText(sigText.value);
    const asc = m.actualBoundingBoxAscent || 52, desc = m.actualBoundingBoxDescent || 18;
    out.width = Math.ceil((m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width) + PAD * 2) * S / 2;
    out.height = Math.ceil(asc + desc + PAD * 2) * S / 2;
    c.scale(S / 2, S / 2);
    c.font = font; // resizing the canvas resets its state
    c.fillStyle = ink;
    c.fillText(sigText.value, PAD + (m.actualBoundingBoxLeft || 0), PAD + asc);
  }
  return out.toDataURL('image/png');
}

async function useSignature() {
  if (sigMode === 'draw' && !strokes.length) {
    padHint.hidden = false;
    padHint.textContent = 'Draw your signature first';
    padHint.style.color = 'var(--blue)';
    return;
  }
  if (sigMode === 'type' && !sigText.value.trim()) {
    sigText.focus();
    return;
  }
  const src = await signaturePng();
  sigDialog.close();
  addSignature(src, $('sigRemember').checked);
}

$('sigUse').addEventListener('click', useSignature);
$('sigCancel').addEventListener('click', () => sigDialog.close());
$('sigForm').addEventListener('submit', (e) => {
  e.preventDefault(); // Enter in the name field means "use it"
  useSignature();
});
// Resize the pad if the dialog changes size (e.g. phone rotation).
new ResizeObserver(() => sigDialog.open && sigMode === 'draw' && sizePad()).observe(sigPad);

// ---------- Toolbar ----------

blockSize.addEventListener('input', () => {
  blockOut.textContent = blockSize.value;
});

async function undo() {
  if (!history.length || drag) return;
  const i = history.pop();
  doc.pages[i].actions.pop();
  if (i !== current) await showPage(i);
  changed();
}
undoBtn.addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  if (!doc || sigDialog.open) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowLeft') return goPage(-1);
  if (e.key === 'ArrowRight') return goPage(1);
  const key = e.key.toLowerCase();
  if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
  else if (!colorOpts.hidden && swatchColors[+key - 1]) setColor(swatchColors[+key - 1]);
});

// Clear only touches the page on screen.
$('resetBtn').addEventListener('click', () => {
  page().actions = [];
  history = history.filter((i) => i !== current);
  changed();
});

$('newBtn').addEventListener('click', () => fileInput.click());
// The browse link only exists on desktop; on touch devices the whole drop area is the button.
$('browseBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

// ---------- Export ----------

function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => (toast.hidden = true), 2600);
}

const hasSignature = () => doc.pages.some((p) => p.actions.some((a) => a.type === 'sign'));
const exportType = () => (doc.kind === 'pdf' ? 'application/pdf' : 'image/png');
const exportName = () => `${doc.name}-${hasSignature() ? 'signed' : 'blurred'}.${doc.kind === 'pdf' ? 'pdf' : 'png'}`;
const toBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));

// The page with every mark burned in.
async function flattenPage(i) {
  const p = doc.pages[i];
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  const cx = c.getContext('2d');
  cx.drawImage(await ensureBase(i), 0, 0, p.w, p.h);
  p.actions.forEach((a) => draw(cx, a));
  return c;
}

// Just the marks, on a transparent canvas, to lay over an untouched PDF page.
function overlayPage(i) {
  const p = doc.pages[i];
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  const cx = c.getContext('2d');
  p.actions.forEach((a) => draw(cx, a));
  return c;
}

async function exportPdf() {
  await loadScript('vendor/pdf-lib.min.js');
  const { PDFDocument } = PDFLib;
  const out = await PDFDocument.create();
  let src = null;
  try {
    src = await PDFDocument.load(doc.bytes, { ignoreEncryption: true });
    if (src.isEncrypted) src = null;
  } catch {
    src = null; // unusual PDFs still export, just with every page flattened
  }

  for (let i = 0; i < doc.pages.length; i++) {
    const p = doc.pages[i];
    const srcPage = src && i < src.getPageCount() ? src.getPage(i) : null;
    // Pixelated pages become an image so the hidden text is really gone, not just
    // covered up. Marked-up rotated pages are flattened too, so marks stay where they
    // were drawn. Untouched pages always pass through as they are.
    const rotated = srcPage && srcPage.getRotation().angle % 360 !== 0;
    const flatten =
      !srcPage || (p.actions.length > 0 && (rotated || p.actions.some((a) => a.type === 'pixelate')));

    if (flatten) {
      const png = await out.embedPng(await (await toBlob(await flattenPage(i))).arrayBuffer());
      out.addPage([p.ptW, p.ptH]).drawImage(png, { x: 0, y: 0, width: p.ptW, height: p.ptH });
      continue;
    }

    // Otherwise keep the original page (real, selectable text) and lay the marks on top.
    const [copy] = await out.copyPages(src, [i]);
    out.addPage(copy);
    if (p.actions.length) {
      const png = await out.embedPng(await (await toBlob(overlayPage(i))).arrayBuffer());
      const box = copy.getCropBox();
      copy.drawImage(png, { x: box.x, y: box.y, width: box.width, height: box.height });
    }
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

async function exportBlob() {
  // Signatures must be decoded before they can be drawn into the export.
  await Promise.all([...sigImages.values()].map((img) => img.decode().catch(() => {})));
  return doc.kind === 'pdf' ? exportPdf() : toBlob(await flattenPage(0));
}

const exportFile = async () => new File([await exportBlob()], exportName(), { type: exportType() });

// The share sheet must open straight from the tap, so on phones the file is
// built ahead of time whenever the document changes.
let shareReady = null; // { version, file }

function prepareShare() {
  if (!isTouch || !navigator.canShare) return;
  clearTimeout(prepareShare.t);
  prepareShare.t = setTimeout(async () => {
    const v = version;
    const file = await exportFile();
    if (v === version) shareReady = { version: v, file };
  }, 400);
}

async function shareFile() {
  let file = shareReady?.version === version ? shareReady.file : null;
  if (!file) file = await exportFile();
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    // NotAllowedError: the tap "expired" while the file was still being built.
    if (err.name === 'NotAllowedError') {
      shareReady = { version, file };
      showToast('Ready. Tap Save again');
    }
    // AbortError: the share sheet was closed. Nothing to do.
  }
  return true;
}

downloadBtn.addEventListener('click', async () => {
  if (!doc) return;
  // Phones: share sheet, which offers "Save Image" (Photos) or "Save to Files".
  if (isTouch && navigator.canShare && (await shareFile())) return;

  // Chrome / Edge / Arc: native "Save as" dialog so you can pick the folder.
  // Ask for the location first: the browser only allows it right after the click.
  if (window.showSaveFilePicker) {
    try {
      const pdf = doc.kind === 'pdf';
      const handle = await window.showSaveFilePicker({
        suggestedName: exportName(),
        types: [
          pdf
            ? { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }
            : { description: 'PNG image', accept: { 'image/png': ['.png'] } },
        ],
      });
      if (pdf) showToast('Preparing PDF…');
      const blob = await exportBlob();
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast(`Saved ${handle.name}`);
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Could not save the file');
    }
    return;
  }

  // Safari / Firefox fallback: regular download.
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await exportBlob());
  a.download = exportName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Downloaded');
});
