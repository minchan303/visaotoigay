mermaid.initialize({ startOnLoad: false });

const $ = (id) => document.getElementById(id);
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

let lastMindmapSvg = ""; // for export

async function postJSON(path, data) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return r.json();
}

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

fetchBtn.addEventListener("click", async () => {
  const u = urlEl.value.trim();
  if (!u) return alert("Nhập URL");
  setLoading(true);
  const j = await postJSON("/api/process", { inputType: "url", url: u, mode: modeEl.value });
  handleResponse(j);
});

generateBtn.addEventListener("click", async () => {
  const inputType = "text";
  const txt = textEl.value.trim();
  if (!txt) return alert("Nhập văn bản hoặc upload file/URL");
  setLoading(true);
  const j = await postJSON("/api/process", { inputType, text: txt, mode: modeEl.value });
  handleResponse(j);
});

function setLoading(isLoading) {
  generateBtn.disabled = isLoading;
  fetchBtn.disabled = isLoading;
  uploadBtn.disabled = isLoading;
  exportPngBtn.style.display = "none";
  resultEl.innerHTML = isLoading ? "⏳ Đang xử lý..." : "";
}

function handleResponse(j) {
  setLoading(false);
  if (!j) {
    resultEl.innerText = "No response";
    return;
  }
  if (!j.success) {
    resultEl.innerText = "❌ " + (j.error || "Unknown error");
    return;
  }

  if (j.type === "text") {
    resultEl.innerText = j.output;
    return;
  }

  if (j.type === "mindmap_json") {
    renderMindmapFromJson(j.output);
    return;
  }

  // fallback
  resultEl.innerText = JSON.stringify(j);
}

// Render mindmap JSON (expects {title, nodes: [{label, children: [...]}]})
function renderMindmapFromJson(data) {
  try {
    // build mermaid graph (flowchart with hierarchical edges)
    // We'll give each node an ID; traverse tree
    let idCounter = 0;
    function newId() { idCounter += 1; return 'N' + idCounter; }

    const lines = [];
    const nodes = [];

    function walk(node, parentId = null) {
      const id = newId();
      const label = (node.label || node.name || "").replace(/["]/g, '\\"');
      nodes.push(`${id}["${label}"]`);
      if (parentId) lines.push(`${parentId} --> ${id}`);
      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => walk(child, id));
      }
      return id;
    }

    const rootId = newId();
    const title = (data.title || "Mindmap").replace(/["]/g, '\\"');
    nodes.push(`${rootId}["${title}"]`);
    if (Array.isArray(data.nodes)) {
      data.nodes.forEach(n => {
        const childId = walk(n, rootId);
      });
    }

    const mermaidText = `flowchart TB\n${nodes.join("\n")}\n${lines.join("\n")}`;
    // render with mermaid - use mermaid.mermaidAPI.render
    const insertId = "mermaid-" + Date.now();
    mermaid.mermaidAPI.render(insertId, mermaidText, (svgCode) => {
      resultEl.innerHTML = svgCode;
      lastMindmapSvg = svgCode;
      exportPngBtn.style.display = "inline-block";
    }, resultEl);
  } catch (e) {
    resultEl.innerText = "Render error: " + e.message;
  }
}

// Export current SVG (lastMindmapSvg) to PNG and download
exportPngBtn.addEventListener("click", async () => {
  if (!lastMindmapSvg) return alert("Không có mindmap để xuất.");
  // convert svg string to image
  const svg = lastMindmapSvg;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    const scale = 2; // increase resolution
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
  img.onerror = (e) => {
    alert("Không thể chuyển SVG sang PNG.");
    URL.revokeObjectURL(url);
  };
  img.src = url;
});
