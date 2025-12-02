mermaid.initialize({ startOnLoad: false });

const $ = id => document.getElementById(id);
const modeEl = $("mode");
const textEl = $("text");
const fileEl = $("file");
const uploadBtn = $("uploadBtn");
const uploadInfo = $("uploadInfo");
const fetchBtn = $("fetchBtn");
const urlEl = $("url");
const generateBtn = $("generateBtn");
const resultEl = $("result");
const exportPngBtn = $("exportPngBtn");

const imgFileEl = $("imgFile");
const ocrBtn = $("ocrBtn");
const ocrStatus = $("ocrStatus");

const newTitleEl = $("newTitle");
const setTitleBtn = $("setTitleBtn");
const appTitleEl = $("appTitle");

let lastMindmapSvg = "";

// helper
async function postJSON(path, data) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return r.json();
}

// upload file
uploadBtn.addEventListener("click", async () => {
  const f = fileEl.files[0];
  if (!f) return alert("Chọn file trước");
  const fd = new FormData();
  fd.append("file", f);
  uploadInfo.textContent = "Uploading...";
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (j.success) {
      uploadInfo.innerHTML = `Uploaded: <a href="${j.fileUrl}" target="_blank">${j.fileUrl}</a>`;
      if (j.extractedText) textEl.value = j.extractedText.slice(0, 20000);
    } else {
      uploadInfo.textContent = "Upload failed: " + (j.error || "");
    }
  } catch (e) {
    uploadInfo.textContent = "Upload error";
  }
});

// fetch URL generate
fetchBtn.addEventListener("click", async () => {
  const u = urlEl.value.trim();
  if (!u) return alert("Nhập URL");
  setLoading(true);
  const j = await postJSON("/api/process", { inputType: "url", url: u, mode: modeEl.value });
  handleResponse(j);
});

// generate from text
generateBtn.addEventListener("click", async () => {
  const txt = textEl.value.trim();
  if (!txt) return alert("Nhập văn bản hoặc upload file/URL");
  setLoading(true);
  const j = await postJSON("/api/process", { inputType: "text", text: txt, mode: modeEl.value });
  handleResponse(j);
});

// OCR image using Tesseract.js in browser
ocrBtn.addEventListener("click", async () => {
  const f = imgFileEl.files[0];
  if (!f) return alert("Choose an image file first");
  ocrStatus.textContent = "OCR in progress...";
  setLoading(true);
  try {
    const { createWorker } = Tesseract;
    const worker = createWorker({ logger: m => {
      // console.log(m);
      ocrStatus.textContent = `OCR: ${Math.round((m.progress||0)*100)}% ${m.status||''}`;
    }});
    await worker.load();
    await worker.loadLanguage('eng+vie'); // try english + vietnamese
    await worker.initialize('eng+vie');
    const { data: { text } } = await worker.recognize(f);
    await worker.terminate();
    textEl.value = (textEl.value ? (textEl.value + "\n\n" + text) : text).slice(0, 20000);
    ocrStatus.textContent = "OCR done. Extracted text inserted into textarea.";
  } catch (e) {
    console.error("OCR error", e);
    ocrStatus.textContent = "OCR failed: " + e.message;
  } finally {
    setLoading(false);
  }
});

// handle response
function handleResponse(j) {
  setLoading(false);
  if (!j) {
    resultEl.textContent = "No response";
    return;
  }
  if (!j.success) {
    resultEl.textContent = "❌ " + (j.error || "Unknown error");
    return;
  }

  if (j.type === "text") {
    resultEl.textContent = j.output;
    exportPngBtn.style.display = "none";
    return;
  }

  if (j.type === "mindmap_json") {
    renderMindmapFromJson(j.output);
    return;
  }

  if (j.type === "mindmap_text") {
    // j.output has { json: {...}, text: "• ..." }
    const html = `<h3>${escapeHtml(j.output.json?.title || "Mindmap")}</h3>
<pre style="white-space:pre-wrap;">${escapeHtml(j.output.text || '')}</pre>`;
    resultEl.innerHTML = html;
    exportPngBtn.style.display = "none";
    return;
  }

  // fallback
  resultEl.textContent = JSON.stringify(j);
}

// render mindmap json -> mermaid flowchart & show export button
function renderMindmapFromJson(data) {
  try {
    let idCounter = 0;
    function newId(){ idCounter++; return 'N' + idCounter; }
    const nodes = [];
    const edges = [];
    function walk(node, parentId){
      const id = newId();
      const label = (node.label || node.name || '').replace(/"/g, '\\"');
      nodes.push(`${id}["${label}"]`);
      if (parentId) edges.push(`${parentId} --> ${id}`);
      if (node.children && Array.isArray(node.children)){
        node.children.forEach(c => walk(c, id));
      }
    }
    const rootId = newId();
    const title = (data.title || 'Mindmap').replace(/"/g, '\\"');
    nodes.push(`${rootId}["${title}"]`);
    if (Array.isArray(data.nodes)) data.nodes.forEach(n => walk(n, rootId));

    const mermaidText = `flowchart TB\n${nodes.join('\n')}\n${edges.join('\n')}`;
    const insertId = 'mermaid-'+Date.now();
    mermaid.mermaidAPI.render(insertId, mermaidText, (svgCode) => {
      resultEl.innerHTML = svgCode;
      lastMindmapSvg = svgCode;
      exportPngBtn.style.display = "inline-block";
    }, resultEl);
  } catch (e) {
    resultEl.textContent = "Render error: " + e.message;
  }
}

// Export svg to png
exportPngBtn.addEventListener("click", () => {
  if (!lastMindmapSvg) return alert("Không có mindmap để xuất.");
  const svg = lastMindmapSvg;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    const scale = 2;
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img, 0,0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mindmap.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  img.onerror = () => {
    alert("Không thể chuyển SVG sang PNG.");
    URL.revokeObjectURL(url);
  };
  img.src = url;
});

// set title safely (block offensive content)
setTitleBtn.addEventListener("click", () => {
  const newTitle = newTitleEl.value.trim();
  if (!newTitle) return alert("Nhập tiêu đề mới");
  // simple check: block words that are slurs (basic)
  const lowered = newTitle.toLowerCase();
  const blocked = ["gay", "slur-example"]; // blocked list - expand as needed
  for (const b of blocked) {
    if (lowered.includes(b)) {
      return alert("Tiêu đề chứa từ không phù hợp. Vui lòng chọn tiêu đề khác.");
    }
  }
  appTitleEl.textContent = newTitle;
  newTitleEl.value = "";
});

// ui helpers
function setLoading(isLoading) {
  generateBtn.disabled = isLoading;
  fetchBtn.disabled = isLoading;
  uploadBtn.disabled = isLoading;
  ocrBtn.disabled = isLoading;
  exportPngBtn.style.display = "none";
  resultEl.innerHTML = isLoading ? "⏳ Đang xử lý..." : "";
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"'`]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'})[c]);
}
