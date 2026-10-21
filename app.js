const $ = (id) => document.getElementById(id);

const drop = $('drop');
const fileInput = $('fileInput');
const stage = $('stage');
const actionsBar = $('actions');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const sel = $('sel');
const blockSize = $('blockSize');
const blockOut = $('blockOut');
const undoBtn = $('undoBtn');
const toast = $('toast');
const dropOverlay = $('dropOverlay');
const pixelOpts = $('pixelOpts');
const colorOpts = $('colorOpts');
const hint = $('hint');

let image = null;        // original, never modified
let fileName = 'screenshot';
let actions = [];        // pixelate regions and shapes, drawn in order
let drag = null;         // { x0, y0, x1, y1, shift } while dragging
let tool = 'pixelate';   // pixelate | rect | ellipse | line | arrow
let color = '#ef4444';

const HINTS = {
  pixelate: 'Drag across anything sensitive to pixelate it',
  rect: 'Drag to draw a box · hold Shift for a square',
  ellipse: 'Drag to draw a circle · hold Shift for a perfect circle',
  line: 'Drag to draw a line · hold Shift to snap the angle',
  arrow: 'Drag from tail to tip · hold Shift to snap the angle',
};

// ---------- Loading ----------

function loadFile(file, source) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('That’s not an image');
    return;
  }
  // Clipboard images come through as a generic "image.png"; give them a useful name.
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  fileName = generic
    ? `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
    : file.name.replace(/\.[^.]+$/, '');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    image = img;
    actions = [];
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    drop.hidden = true;
    stage.hidden = false;
    actionsBar.hidden = false;
    render();
    if (source) showToast(source);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Couldn’t open that image');
  };
  img.src = url;
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  loadFile(fileInput.files[0]);
  fileInput.value = '';
});

// Drag & drop works anywhere on the page, before or after an image is open.
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
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  loadFile(file || e.dataTransfer.files[0], image ? 'Image replaced' : null);
});

// ⌘V / Ctrl+V pastes a screenshot from the clipboard (or an image file copied in Finder).
document.addEventListener('paste', (e) => {
  const files = [
    ...[...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()),
    ...e.clipboardData.files,
  ];
  const file = files.find((f) => f && f.type.startsWith('image/'));
  if (!file) {
    showToast('No image on the clipboard');
    return;
  }
  e.preventDefault();
  loadFile(file, image ? 'Pasted new image' : 'Pasted');
});

// ---------- Rendering ----------

// Scale sizes with the image so tools feel the same on any resolution.
const imageScale = () => Math.max(1, Math.max(canvas.width, canvas.height) / 1400);
const blockFor = (value) => Math.round(value * imageScale());
const strokeWidth = () => Math.round(5 * imageScale());

function pixelate(r) {
  const x = Math.round(r.x), y = Math.round(r.y);
  const w = Math.round(r.w), h = Math.round(r.h);
  if (w < 1 || h < 1) return;

  // Average every pixel in each block so no detail leaks through.
  const b = r.block;
  const data = ctx.getImageData(x, y, w, h);
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
  ctx.putImageData(data, x, y);
}

function drawShape(a) {
  const { x0, y0, x1, y1 } = a;
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  if (a.type === 'rect') {
    ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.stroke();
  } else if (a.type === 'ellipse') {
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (a.type === 'line') {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  } else if (a.type === 'arrow') {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const head = Math.min(len * 0.6, a.width * 4.5);
    const spread = 0.45;
    // Stop the shaft inside the head so the tip stays sharp.
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - Math.cos(ang) * head * 0.8, y1 - Math.sin(ang) * head * 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(ang - spread), y1 - head * Math.sin(ang - spread));
    ctx.lineTo(x1 - head * Math.cos(ang + spread), y1 - head * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function draw(a) {
  if (a.type === 'pixelate') pixelate(a);
  else drawShape(a);
}

function render() {
  if (!image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  actions.forEach(draw);
  if (drag) draw(currentAction());
  undoBtn.disabled = actions.length === 0;
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

// Turns the drag into an action, applying Shift constraints.
function currentAction() {
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
  if (a.type === 'pixelate') return a.w > 2 && a.h > 2;
  return Math.hypot(a.x1 - a.x0, a.y1 - a.y0) > 3;
}

function showSelection() {
  if (tool !== 'pixelate') return;
  const r = currentAction();
  const k = canvas.getBoundingClientRect().width / canvas.width;
  sel.style.left = r.x * k + 'px';
  sel.style.top = r.y * k + 'px';
  sel.style.width = r.w * k + 'px';
  sel.style.height = r.h * k + 'px';
  sel.hidden = false;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const p = toImage(e);
  drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey };
  showSelection();
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
  if (isMeaningful(a)) actions.push(a);
  render();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------- Tools & colours ----------

function setTool(t) {
  tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  pixelOpts.hidden = t !== 'pixelate';
  colorOpts.hidden = t === 'pixelate';
  hint.textContent = `${HINTS[t]} · ⌘V or drop to swap image`;
}

function setColor(c) {
  color = c;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === c));
}

document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => setColor(s.dataset.color)));

const TOOL_KEYS = { p: 'pixelate', b: 'rect', r: 'rect', o: 'ellipse', c: 'ellipse', l: 'line', a: 'arrow' };
const swatchColors = [...document.querySelectorAll('.swatch')].map((s) => s.dataset.color);

// ---------- Toolbar ----------

blockSize.addEventListener('input', () => {
  blockOut.textContent = blockSize.value;
});

function undo() {
  actions.pop();
  render();
}
undoBtn.addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  if (!image) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
  else if (tool !== 'pixelate' && swatchColors[+key - 1]) setColor(swatchColors[+key - 1]);
});

$('resetBtn').addEventListener('click', () => {
  actions = [];
  render();
});

$('newBtn').addEventListener('click', () => fileInput.click());
$('browseBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

// ---------- Download ----------

function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => (toast.hidden = true), 2600);
}

$('downloadBtn').addEventListener('click', async () => {
  render();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const suggestedName = `${fileName}-blurred.png`;

  // Chrome / Edge / Arc: native "Save as" dialog so you can pick the folder.
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
      });
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
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Downloaded');
});
