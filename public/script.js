// script.js
mermaid.initialize({ startOnLoad: false });

const $ = id => document.getElementById(id);

const textEl = $("text");
const fileEl = $("file");
const uploadBtn = $("uploadBtn");
const ocrBtn = $("ocrBtn");
const uploadInfo = $("uploadInfo");
const urlEl = $("url");
const fetchBtn = $("fetchBtn");
const generateBtn = $("generateBtn");
const resultEl = $("result");
const modeEl = $("mode");
const exportPdfBtn = $("exportPdfBtn");
const exportPngBtn = $("exportPngBtn");

let lastMindmapSvg = "";
let activeChart = null;

async function postJSON(path, data) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return r.json();
}

/* ---------------- Upload file to server ---------------- */
uploadBtn.addEventListener("click", async () => {
  const f = fileEl.files[0];
  if (!f) return alert("Vui lòng chọn file trước khi upload.");
  const fd = new FormData();
  fd.append("file", f);
  uploadInfo.textContent = "Đang upload...";
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (!j.success) {
      uploadInfo.textContent = "Upload lỗi: " + (j.error || "");
      return;
    }
    uploadInfo.innerHTML = `Uploaded: <a href="${j.fileUrl}" target="_blank">${j.fileUrl}</a>`;
    if (j.extractedText) textEl.value = j.extractedText;
    if (j.isGrade) uploadInfo.innerHTML += `<div class="muted">Bảng điểm được phát hiện — chọn mode và bấm Generate để vẽ chart.</div>`;
  } catch (e) {
    console.error(e);
    uploadInfo.textContent = "Upload thất bại.";
  }
});

/* ---------------- Fetch URL & generate ---------------- */
fetchBtn.addEventListener("click", async () => {
  const u = urlEl.value.trim();
  if (!u) return alert("Nhập URL.");
  setLoading(true);
  const j = await postJSON("/api/process", { inputType: "url", url: u, mode: modeEl.value });
  setLoading(false);
  handleResponse(j);
});

/* ---------------- Generate (text / file / url) ---------------- */
generateBtn.addEventListener("click", async () => {
  const payload = { mode: modeEl.value };

  if (textEl.value.trim()) {
    payload.inputType = "text";
    payload.text = textEl.value;
  } else if (uploadInfo.querySelector && uploadInfo.querySelector("a")) {
    payload.inputType = "file";
    payload.fileUrl = uploadInfo.querySelector("a").href;
  } else if (urlEl.value.trim()) {
    payload.inputType = "url";
    payload.url = urlEl.value.trim();
  } else {
    return alert("Hãy nhập văn bản, upload file hoặc dán URL.");
  }

  setLoading(true);
  try {
    const j = await postJSON("/api/process", payload);
    setLoading(false);
    handleResponse(j);
  } catch (e) {
    setLoading(false);
    console.error(e);
    resultEl.innerHTML = `<div class="error">Network/Server error: ${e.message}</div>`;
  }
});

/* ---------------- OCR (client-side) ----------------
   - If file is image -> OCR directly
   - If file is PDF -> render first N pages with pdf.js and OCR each
---------------------------------------------------- */
ocrBtn.addEventListener("click", async () => {
  const f = fileEl.files[0];
  if (!f) return alert("Chọn file PDF hoặc ảnh để OCR.");
  setLoading(true);
  uploadInfo.textContent = "OCR đang chạy (client-side)...";
  try {
    if (f.type.startsWith("image/")) {
      const dataUrl = await readFileAsDataURL(f);
      const { data } = await Tesseract.recognize(dataUrl, 'vie+eng', { logger: m => console.log(m) });
      textEl.value = (textEl.value ? textEl.value + "\n\n" : "") + (data.text || "");
      uploadInfo.textContent = "OCR ảnh xong — text đã chèn vào textarea.";
    } else if (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")) {
      const arrayBuffer = await f.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = "";
      const maxPages = Math.min(pdf.numPages, 3); // limit pages to speed up
      for (let p = 1; p <= maxPages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        // OCR this canvas
        const dataUrl = canvas.toDataURL("image/png");
        const { data } = await Tesseract.recognize(dataUrl, 'vie+eng', { logger: m => console.log(m) });
        fullText += "\n\n" + (data.text || "");
      }
      textEl.value = (textEl.value ? textEl.value + "\n\n" : "") + fullText.trim();
      uploadInfo.textContent = `OCR PDF xong (${Math.min(pdf.numPages, 3)} trang) — text đã chèn.`;
    } else {
      uploadInfo.textContent = "File không hỗ trợ OCR client-side (chỉ PDF hoặc ảnh).";
    }
  } catch (e) {
    console.error(e);
    uploadInfo.textContent = "OCR lỗi: " + e.message;
  } finally {
    setLoading(false);
  }
});

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

/* ---------------- Handle server response & render nicely ---------------- */
function handleResponse(j) {
  if (!j) { resultEl.textContent = "No response"; return; }
  if (!j.success) {
    resultEl.innerHTML = `<div class="error">Lỗi: ${escapeHtml(j.error || "Unknown")}</div>`;
    return;
  }

  exportPdfBtn.style.display = "none";
  exportPngBtn.style.display = "none";

  if (j.type === "text") {
    const mode = modeEl.value;
    if (mode === "flashcards") {
      renderFlashcardsFromJsonString(j.output);
    } else if (mode === "qa" || mode === "learning_sections" || mode === "summary") {
      resultEl.innerHTML = `<div class="pretty-text">${escapeHtml(j.output)}</div>`;
      exportPdfBtn.style.display = "inline-block";
    } else {
      resultEl.innerHTML = `<pre>${escapeHtml(j.output)}</pre>`;
      exportPdfBtn.style.display = "inline-block";
    }
    return;
  }

  if (j.type === "chart") {
    renderChart(j.chart);
    return;
  }

  if (j.type === "mindmap_text") {
    const out = j.output;
    let html = `<div class="mindmap-text"><pre>${escapeHtml(out.text || "")}</pre></div>`;
    resultEl.innerHTML = html + `<div id="mm"></div>`;
    try {
      const mm = out.json || out;
      renderMindmapJson(mm);
    } catch (e) {
      console.error(e);
    }
    return;
  }

  resultEl.innerHTML = `<pre>${escapeHtml(JSON.stringify(j, null, 2))}</pre>`;
}

/* ---------------- Flashcards ---------------- */
function renderFlashcardsFromJsonString(s) {
  let arr = null;
  try {
    arr = JSON.parse(s);
  } catch (e) {
    const m = s.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr)) {
    resultEl.innerHTML = `<pre>${escapeHtml(s)}</pre>`;
    return;
  }
  const html = arr.map(card => `
    <div class="flashcard">
      <div class="q">${escapeHtml(card.q)}</div>
      <div class="a">${escapeHtml(card.a)}</div>
    </div>`).join("");
  resultEl.innerHTML = `<div class="flashcards">${html}</div>`;
  exportPdfBtn.style.display = "inline-block";
}

/* ---------------- Chart (Chart.js) ---------------- */
function renderChart(chartObj) {
  resultEl.innerHTML = `<canvas id="chartCanvas"></canvas>`;
  const ctx = document.getElementById("chartCanvas").getContext("2d");
  if (activeChart) try { activeChart.destroy(); } catch (e) {}
  const datasets = (chartObj.datasets || []).map(ds => ({
    label: ds.label || "Series",
    data: ds.data || [],
    fill: false
  }));
  activeChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: chartObj.labels || [], datasets },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

/* ---------------- Mindmap (Mermaid) ---------------- */
function renderMindmapJson(data) {
  let idCounter = 0;
  function nid(){ return 'N' + (++idCounter); }
  const nodes = [];
  const edges = [];

  const rootId = nid();
  nodes.push(`${rootId}["${escapeForMermaid(data.title || 'Mindmap')}"]`);

  function walk(node, parent) {
    const id = nid();
    nodes.push(`${id}["${escapeForMermaid(node.label || node.name || '')}"]`);
    edges.push(`${parent} --> ${id}`);
    if (Array.isArray(node.children)) node.children.forEach(c => walk(c, id));
  }

  if (Array.isArray(data.nodes)) data.nodes.forEach(n => walk(n, rootId));

  const mermaidText = `flowchart TB\n${nodes.join("\n")}\n${edges.join("\n")}`;
  mermaid.mermaidAPI.render('mermaidGraph', mermaidText, svgCode => {
    const mmDiv = document.getElementById("mm");
    mmDiv.innerHTML = svgCode;
    lastMindmapSvg = svgCode;
    exportPngBtn.style.display = "inline-block";
  });
}

function escapeForMermaid(s) {
  return (s || '').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/* ---------------- Export PDF ---------------- */
exportPdfBtn.addEventListener("click", async () => {
  const html = resultEl.innerHTML;
  const title = document.getElementById("appTitle").textContent || "Result";
  const res = await fetch("/api/export/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, html })
  });
  if (!res.ok) return alert("Export PDF lỗi");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "result.pdf"; a.click();
});

/* ---------------- Export Mindmap PNG ---------------- */
exportPngBtn.addEventListener("click", () => {
  if (!lastMindmapSvg) return alert("Không có mindmap để xuất.");
  const svg = lastMindmapSvg;
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;
    const ctx = canvas.getContext("2d");
    ctx.scale(2,2);
    ctx.drawImage(img, 0, 0);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = "mindmap.png";
    a.click();
    URL.revokeObjectURL(url);
  };
  img.src = url;
});

/* ---------------- Helpers ---------------- */
function setLoading(is) {
  generateBtn.disabled = is;
  fetchBtn.disabled = is;
  uploadBtn.disabled = is;
  ocrBtn.disabled = is;
  resultEl.innerHTML = is ? "<div class='muted'>Đang xử lý…</div>" : "";
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

function escapeForDownload(s) {
  return s;
}
