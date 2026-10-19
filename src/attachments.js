// Turns files the user drops, pastes or attaches into content Claude can read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.log', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.psm1', '.bat', '.cmd', '.sh', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.sql', '.lua', '.toml', '.env', '.svg', '.dxf', '.lsp', '.scr', '.vb',
  '.vbs', '.reg', '.srt', '.vtt', '.rtf',
]);
const MAX_TEXT_BYTES = 400 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1568;

function kindOf(p, size) {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return size <= MAX_PDF_BYTES ? 'pdf' : 'file';
  if (TEXT_EXT.has(ext)) return size <= MAX_TEXT_BYTES ? 'text' : 'file';
  if (size <= MAX_TEXT_BYTES && looksLikeText(p)) return 'text';
  return 'file';
}

function looksLikeText(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    return n > 0 && !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// For the UI chips: name, size, kind and a small thumbnail for images.
function describe(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return { path: p, name: path.basename(p), kind: 'folder', size: '' };
    const kind = kindOf(p, st.size);
    let thumb = null;
    if (kind === 'image') {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) thumb = img.resize({ height: 96 }).toDataURL();
    }
    return { path: p, name: path.basename(p), kind, size: fmtSize(st.size), thumb };
  } catch (err) {
    return { path: p, name: path.basename(p), kind: 'missing', size: '', error: err.message };
  }
}

function savePasted(name, buf) {
  const dir = path.join(os.tmpdir(), 'jarvis-pasted');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (name || 'pasted.png').replace(/[^\w.-]+/g, '_');
  const file = path.join(dir, `${Date.now()}-${safe}`);
  fs.writeFileSync(file, buf);
  return file;
}

function imageBlock(p) {
  let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const long = Math.max(width, height);
  if (long > MAX_IMAGE_EDGE) {
    img = width >= height ? img.resize({ width: MAX_IMAGE_EDGE, quality: 'good' }) : img.resize({ height: MAX_IMAGE_EDGE, quality: 'good' });
  }
  const ext = path.extname(p).toLowerCase();
  const usePng = ext === '.png' && fs.statSync(p).size < 3 * 1024 * 1024 && long <= MAX_IMAGE_EDGE;
  const data = usePng ? fs.readFileSync(p) : img.toJPEG(88);
  return { type: 'image', source: { type: 'base64', media_type: usePng ? 'image/png' : 'image/jpeg', data: data.toString('base64') } };
}

// Content blocks to put in the user's message.
function toBlocks(paths) {
  const blocks = [];
  const notes = [];
  for (const p of paths) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      notes.push(`- ${p} (could not be read — missing?)`);
      continue;
    }
    if (st.isDirectory()) {
      notes.push(`- Folder: ${p} (use list_directory / PowerShell to look inside)`);
      continue;
    }
    const kind = kindOf(p, st.size);
    const label = `${path.basename(p)} — ${p} (${fmtSize(st.size)})`;
    try {
      if (kind === 'image') {
        const b = imageBlock(p);
        if (b) {
          blocks.push({ type: 'text', text: `Attached image: ${label}` });
          blocks.push(b);
          continue;
        }
      } else if (kind === 'pdf') {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') },
          title: path.basename(p),
        });
        notes.push(`- PDF shown above: ${label}`);
        continue;
      } else if (kind === 'text') {
        blocks.push({ type: 'text', text: `<file name="${path.basename(p)}" path="${p}">\n${fs.readFileSync(p, 'utf8')}\n</file>` });
        continue;
      }
    } catch {}
    notes.push(`- ${label} — not readable directly; open it with your tools (PowerShell, Python, Office COM) if needed`);
  }
  if (notes.length) blocks.push({ type: 'text', text: `Attached files:\n${notes.join('\n')}` });
  return blocks;
}

module.exports = { describe, savePasted, toBlocks, kindOf };
