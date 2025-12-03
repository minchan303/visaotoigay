const $ = id => document.getElementById(id);

const textEl = $("text");
const fileEl = $("file");
const uploadBtn = $("uploadBtn");
const uploadInfo = $("uploadInfo");
const urlEl = $("url");
const fetchBtn = $("fetchBtn");
const generateBtn = $("generateBtn");
const resultEl = $("result");
const modeEl = $("mode");
const exportBtn = $("exportPngBtn");

let lastSvg = "";

/* UPLOAD -----------------------------------------*/
uploadBtn.addEventListener("click", async () => {
  const file = fileEl.files[0];
  if (!file) return alert("Chọn file trước");

  const fd = new FormData();
  fd.append("file", file);

  uploadInfo.textContent = "Đang upload...";

  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const j = await res.json();

  if (!j.success) {
    uploadInfo.textContent = "Lỗi: " + j.error;
    return;
  }

  uploadInfo.innerHTML = `File đã upload: <b>${j.fileUrl}</b>`;

  if (j.extractedText) textEl.value = j.extractedText;
});

/* URL ---------------------------------------------*/
fetchBtn.addEventListener("click", async () => {
  if (!urlEl.value.trim()) return alert("Nhập URL");

  callProcess({ inputType: "url", url: urlEl.value });
});

/* GENERATE ----------------------------------------*/
generateBtn.addEventListener("click", async () => {
  let payload = {
    mode: modeEl.value
  };

  if (textEl.value.trim()) {
    payload.inputType = "text";
    payload.text = textEl.value;
  } else if (uploadInfo.innerText.includes("uploads/")) {
    payload.inputType = "file";
    payload.fileUrl = uploadInfo.innerText.replace("File đã upload: ", "").trim();
  } else if (urlEl.value.trim()) {
    payload.inputType = "url";
    payload.url = urlEl.value;
  } else {
    return alert("Hãy nhập văn bản hoặc upload file hoặc dán URL");
  }

  callProcess(payload);
});

/* CALL PROCESS ------------------------------------*/
async function callProcess(payload) {
  resultEl.textContent = "⏳ Đang xử lý...";

  const res = await fetch("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const j = await res.json();
  handleResponse(j);
}

/* HANDLE RESPONSE ---------------------------------*/
function handleResponse(j) {
  if (!j.success) {
    resultEl.textContent = "❌ Lỗi: " + j.error;
    return;
  }

  // TEXT RESULTS
  if (j.type === "text") {
    exportBtn.style.display = "none";
    resultEl.textContent = j.output;
    return;
  }

  // CHART
  if (j.type === "chart") {
    exportBtn.style.display = "none";
    renderChart(j.chart);
    return;
  }

  // MINDMAP TEXT
  if (j.type === "mindmap_text") {
    renderMindmap(j.output);
    return;
  }
}

/* RENDER CHART ------------------------------------*/
function renderChart(chart) {
  resultEl.innerHTML = `<canvas id="canvas"></canvas>`;
  const ctx = $("canvas").getContext("2d");

  new Chart(ctx, {
    type: "bar",
    data: chart,
    options: { responsive: true }
  });
}

/* RENDER MINDMAP ----------------------------------*/
function renderMindmap(data) {
  const txt = data.text;
  const json = data.json;

  let idCounter = 0;
  const nid = () => "N" + (++idCounter);

  let nodes = [];
  let edges = [];

  const rootId = nid();
  nodes.push(`${rootId}["${json.title}"]`);

  function walk(node, parent) {
    let id = nid();
    nodes.push(`${id}["${node.label}"]`);
    edges.push(`${parent} --> ${id}`);
    if (node.children) node.children.forEach(c => walk(c, id));
  }

  json.nodes.forEach(n => walk(n, rootId));

  const mermaidCode = `flowchart TB\n${nodes.join("\n")}\n${edges.join("\n")}`;

  resultEl.innerHTML = `
    <pre>${txt}</pre>
    <div id="mm"></div>
  `;

  mermaid.mermaidAPI.render("mindmapGraph", mermaidCode, svg => {
    lastSvg = svg;
    $("mm").innerHTML = svg;
    exportBtn.style.display = "inline-block";
  });
}

/* EXPORT PNG --------------------------------------*/
exportBtn.addEventListener("click", () => {
  if (!lastSvg) return;
  
  const blob = new Blob([lastSvg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;

    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);

    const link = document.createElement("a");
    link.download = "mindmap.png";
    link.href = canvas.toDataURL();
    link.click();
  };

  img.src = url;
});
