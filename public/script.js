// script.js — full client logic for Gemini Study Assistant
// Features: paste/upload/url input, call /api/process, render mindmap (D3), export PNG

// -------------------- config --------------------
const API_PROCESS_JSON = "/api/process"; // JSON endpoint for text/url
const API_UPLOAD = "/api/process"; // endpoint supports upload (server accepts multipart at same route)
const D3_CDN = "https://d3js.org/d3.v7.min.js";

// -------------------- load d3 if missing --------------------
async function ensureD3() {
  if (window.d3) return window.d3;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = D3_CDN;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return window.d3;
}

// -------------------- helpers --------------------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function showLoading(text = "Processing...") {
  const el = $("#loading");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
}
function hideLoading() {
  const el = $("#loading");
  if (!el) return;
  el.classList.add("hidden");
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"'`]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;', '`':'&#96;'
  })[c]);
}

// show error in output
function showError(msg) {
  const out = $("#output");
  out.innerHTML = `<div class="error">Error: ${escapeHtml(String(msg))}</div>`;
}

// -------------------- UI wiring --------------------
const inputRadios = $all("input[name='inputMode']");
const textInput = $("#textInput");
const fileInput = $("#fileInput");
const urlInput = $("#urlInput");
const taskSelect = $("#taskSelect");
const generateBtn = $("#generateBtn");
const clearBtn = $("#clearBtn");
const outputEl = $("#output");
const mindmapContainer = $("#mindmapContainer");
const copyBtn = $("#copyBtn");
const downloadBtn = $("#downloadBtn");
const exportMindmapBtn = $("#exportMindmapBtn");
const loadingEl = $("#loading");

// set initial UI
function setModeUI(mode) {
  if (!textInput || !fileInput || !urlInput) return;
  textInput.classList.add("hidden");
  fileInput.classList.add("hidden");
  urlInput.classList.add("hidden");
  if (mode === "text") textInput.classList.remove("hidden");
  if (mode === "file") fileInput.classList.remove("hidden");
  if (mode === "url") urlInput.classList.remove("hidden");
}
inputRadios.forEach(r => r.addEventListener("change", () => setModeUI(document.querySelector("input[name='inputMode']:checked").value)));
setModeUI(document.querySelector("input[name='inputMode']:checked").value);

// clear
clearBtn.addEventListener("click", () => {
  textInput.value = "";
  urlInput.value = "";
  fileInput.value = null;
  outputEl.innerHTML = "";
  hideMindmap();
});

// copy/download
copyBtn.addEventListener("click", async () => {
  const txt = outputEl.dataset.raw || outputEl.textContent || "";
  try {
    await navigator.clipboard.writeText(txt);
    alert("Đã copy vào clipboard");
  } catch {
    alert("Copy failed");
  }
});

downloadBtn.addEventListener("click", () => {
  const txt = outputEl.dataset.raw || outputEl.textContent || "";
  const a = document.createElement("a");
  const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  a.href = URL.createObjectURL(blob);
  a.download = "output.txt";
  a.click();
});

// -------------------- API calls --------------------
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return await res.json();
}

// upload via FormData
async function postForm(url, form) {
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return await res.json();
}

// -------------------- generate handler --------------------
generateBtn.addEventListener("click", async () => {
  outputEl.innerHTML = "";
  outputEl.dataset.raw = "";
  hideMindmap();
  copyBtn.style.display = "none";
  downloadBtn.style.display = "none";
  exportMindmapBtn.classList.add("hidden");

  const inputMode = document.querySelector("input[name='inputMode']:checked").value;
  const task = taskSelect.value;

  try {
    showLoading("Processing...");
    let responseJson;

    if (inputMode === "file") {
      const file = fileInput.files[0];
      if (!file) { alert("Chưa chọn file"); hideLoading(); return; }
      const fd = new FormData();
      fd.append("file", file);
      fd.append("type", task);
      // server expects multipart at /api/upload or at /api/process (depending on implementation). Try /api/upload first.
      try {
        responseJson = await postForm("/api/upload", fd);
      } catch (e) {
        // fallback: try /api/process
        responseJson = await postForm(API_PROCESS_JSON, fd);
      }
    } else if (inputMode === "url") {
      const url = urlInput.value.trim();
      if (!url) { alert("Chưa nhập URL"); hideLoading(); return; }
      responseJson = await postJSON(API_PROCESS_JSON, { inputType: "url", url, task });
    } else { // text
      const text = textInput.value.trim();
      if (!text) { alert("Chưa nhập văn bản"); hideLoading(); return; }
      responseJson = await postJSON(API_PROCESS_JSON, { inputType: "text", text, task });
    }

    hideLoading();
    handleServerResult(responseJson, task);

  } catch (err) {
    hideLoading();
    console.error(err);
    showError(err.message || err);
  }
});

// -------------------- handle server output --------------------
function handleServerResult(r, task) {
  if (!r) { showError("Server trả về rỗng"); return; }
  if (r.error) { showError(r.error); return; }

  // The server might return different shapes:
  // - { text: "..." }   or { result: "..." }  or { success:true, output: "..." } or { mindmap: {...} }
  const text = r.text || r.result || (r.output && (r.output.text || r.output)) || r;
  // prefer mindmap if present
  if (r.mindmap) {
    renderMindmapFromObject(r.mindmap);
    return;
  }

  // some servers return mindmap JSON string in output when task=mindmap - try parse
  if (task === "mindmap") {
    // try common places
    const maybe = r.output || r.result || r.text || (typeof r === "string" ? r : null);
    let parsed = tryParseJSON(maybe);
    if (!parsed) {
      // try extract JSON substring
      const jsonStr = extractJSON(maybe || "");
      if (jsonStr) parsed = tryParseJSON(jsonStr);
    }
    if (parsed) {
      renderMindmapFromObject(parsed);
      return;
    }
    // if not JSON, try to interpret as simple lines -> build children
    const fallbackText = (maybe || "").toString();
    const lines = fallbackText.split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 30);
    const tree = { name: "Root", children: lines.map(l => ({ name: l })) };
    renderMindmapFromObject(tree);
    outputEl.innerHTML = `<pre>${escapeHtml(fallbackText)}</pre>`;
    outputEl.dataset.raw = fallbackText;
    return;
  }

  // fallback: present as text
  const txt = (r.text || r.result || (r.output && typeof r.output === "string" ? r.output : "")) || "";
  const payloadText = typeof txt === "object" ? JSON.stringify(txt, null, 2) : String(txt || "");
  outputEl.innerHTML = `<pre>${escapeHtml(payloadText)}</pre>`;
  outputEl.dataset.raw = payloadText;
  copyBtn.style.display = "inline-block";
  downloadBtn.style.display = "inline-block";
}

// try parse JSON safely
function tryParseJSON(s) {
  if (!s) return null;
  try {
    if (typeof s !== "string") s = JSON.stringify(s);
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// extract first JSON object/array substring from text
function extractJSON(s) {
  if (!s || typeof s !== "string") return null;
  const start = s.indexOf("{");
  const startArr = s.indexOf("[");
  const idx = (start >= 0 && (start < startArr || startArr === -1)) ? start : startArr;
  if (idx === -1) return null;
  // try progressively larger substrings
  for (let i = s.length; i > idx; i--) {
    const sub = s.substring(idx, i);
    try {
      JSON.parse(sub);
      return sub;
    } catch {}
  }
  return null;
}

// -------------------- Mindmap rendering (professional) --------------------
let currentSvg = null;
async function renderMindmapFromObject(treeData) {
  await ensureD3();
  const d3 = window.d3;
  // clear output text area
  outputEl.innerHTML = "";
  outputEl.dataset.raw = "";

  mindmapContainer.classList.remove("hidden");
  exportMindmapBtn.classList.remove("hidden");
  copyBtn.style.display = "none";
  downloadBtn.style.display = "none";

  // clear previous
  mindmapContainer.innerHTML = "";

  // size & margins
  const width = mindmapContainer.clientWidth || 1100;
  const height = mindmapContainer.clientHeight || 600;
  const margin = { top: 20, right: 40, bottom: 20, left: 40 };

  const svg = d3.select("#mindmapContainer").append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [0, 0, width, height])
    .style("font", "14px 'Inter', Arial");

  currentSvg = svg;

  // add defs for gradients/shadows
  const defs = svg.append("defs");
  const grad = defs.append("radialGradient").attr("id", "g1");
  grad.append("stop").attr("offset", "0%").attr("stop-color", "#ffffff");
  grad.append("stop").attr("offset", "100%").attr("stop-color", "#e9f0ff");

  defs.append("filter").attr("id", "shadow")
    .append("feDropShadow")
    .attr("dx", 0).attr("dy", 3).attr("stdDeviation", 6).attr("flood-opacity", 0.12);

  // create a group for pan/zoom
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // pan & zoom
  svg.call(d3.zoom().scaleExtent([0.3, 3]).on("zoom", (event) => {
    g.attr("transform", event.transform);
  }));

  // convert to d3 hierarchy
  const root = d3.hierarchy(treeData);
  // compute layout - radial style to look like XMind outward? we'll make left-to-right tree with curve links
  const treeLayout = d3.tree().nodeSize([120, 180]).separation((a,b) => (a.parent==b.parent?1:1.4));
  treeLayout(root);

  // center root in left half, translate to center vertically
  const nodes = root.descendants();
  const minX = d3.min(nodes, d => d.x);
  const maxX = d3.max(nodes, d => d.x);
  const minY = d3.min(nodes, d => d.y);
  const maxY = d3.max(nodes, d => d.y);

  // optional: normalize positions to fit canvas nicely
  const availableHeight = height - margin.top - margin.bottom;
  const scale = availableHeight / (maxX - minX + 1e-6);
  nodes.forEach(d => { d.x = (d.x - minX) * scale + 40; d.y = d.y - minY + 60; });

  // links (curved)
  const linkG = g.append("g").attr("class", "links");
  linkG.selectAll("path.link")
    .data(root.links())
    .enter()
    .append("path")
    .attr("class", "link")
    .attr("d", d => {
      // cubic bezier horizontal-ish curve
      const src = { x: d.source.x, y: d.source.y };
      const tgt = { x: d.target.x, y: d.target.y };
      const midX = src.x + (tgt.x - src.x) * 0.5;
      return `M${src.y},${src.x} C ${midX},${src.x} ${midX},${tgt.x} ${tgt.y},${tgt.x}`;
    })
    .attr("fill", "none")
    .attr("stroke", "#cfe2ff")
    .attr("stroke-width", 2);

  // nodes
  const nodeG = g.append("g").attr("class", "nodes");
  const node = nodeG.selectAll("g.node")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", d => "node" + (d.children ? " node--internal" : " node--leaf"))
    .attr("transform", d => `translate(${d.y},${d.x})`)
    .style("cursor", "pointer");

  // circle with gradient and shadow
  node.append("circle")
    .attr("r", 28)
    .attr("fill", (d,i) => i===0 ? "#f8fbff" : "#fff")
    .attr("stroke", "#3b6cff")
    .attr("stroke-width", 2)
    .attr("filter", "url(#shadow)");

  // label
  node.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "0.35em")
    .style("font-weight", 600)
    .style("font-size", 13)
    .text(d => d.data.name)
    .call(wrap, 60);

  // collapse / expand on click
  node.on("click", (event, d) => {
    if (d.children) {
      d._children = d.children;
      d.children = null;
    } else {
      d.children = d._children;
      d._children = null;
    }
    // re-render with new tree
    renderMindmapFromObject(convertD3ToPlain(root)); // call top-level rendering again with updated structure
  });

  // helper: wrap text
  function wrap(textSelection, width) {
    textSelection.each(function() {
      const text = d3.select(this);
      const words = text.text().split(/\s+/).reverse();
      let word, line = [], lineNumber = 0, lineHeight = 1.1;
      const y = text.attr("y") || 0;
      const dy = 0;
      let tspan = text.text(null).append("tspan").attr("x", 0).attr("y", y).attr("dy", dy + "em");
      while (word = words.pop()) {
        line.push(word);
        tspan.text(line.join(" "));
        if (tspan.node().getComputedTextLength() > width) {
          line.pop();
          tspan.text(line.join(" "));
          line = [word];
          tspan = text.append("tspan").attr("x", 0).attr("y", y).attr("dy", ++lineNumber * lineHeight + dy + "em").text(word);
        }
      }
    });
  }

  // make svg responsive
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // helper to convert current d3 hierarchy back to plain object for re-render
  function convertD3ToPlain(rootNode) {
    function traverse(node) {
      return {
        name: node.data.name,
        children: (node.children || node._children || []).map(n => traverse(n))
      };
    }
    return traverse(rootNode);
  }
}

// hide mindmap
function hideMindmap() {
  mindmapContainer.innerHTML = "";
  mindmapContainer.classList.add("hidden");
  exportMindmapBtn.classList.add("hidden");
}

// -------------------- export canvas/png --------------------
exportMindmapBtn.addEventListener("click", () => {
  const svgEl = mindmapContainer.querySelector("svg");
  if (!svgEl) return alert("Không có mindmap để xuất");
  // increase scale for higher resolution
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svgEl);
  const img = new Image();
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  img.onload = () => {
    const canvas = document.createElement("canvas");
    const scale = 2; // export at 2x resolution
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0,0,canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob(blob => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mindmap.png";
      a.click();
    }, "image/png");
  };
  img.onerror = () => { alert("Export failed (image load error)"); };
  img.src = url;
});

// -------------------- initialization --------------------
(function init() {
  // hide controls that may not be present
  if (copyBtn) copyBtn.style.display = "none";
  if (downloadBtn) downloadBtn.style.display = "none";

  // ensure mindmap container has height
  if (mindmapContainer && !mindmapContainer.style.height) mindmapContainer.style.height = "560px";

  // load d3 in background
  ensureD3().catch(e => console.warn("D3 load failed:", e));
})();
