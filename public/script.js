const textInput = document.getElementById("textInput");
const taskSelect = document.getElementById("taskSelect");
const generateBtn = document.getElementById("generateBtn");
const resultBox = document.getElementById("resultBox");
const meta = document.getElementById("meta");

const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const fileInfo = document.getElementById("fileInfo");

const urlInput = document.getElementById("urlInput");
const fetchUrlBtn = document.getElementById("fetchUrlBtn");

// helper display
function setLoading(on, note="") {
  generateBtn.disabled = on;
  uploadBtn.disabled = on;
  fetchUrlBtn.disabled = on;
  resultBox.textContent = on ? "⏳ Đang xử lý..." : "";
  if (!on) meta.textContent = note;
  else meta.textContent = "";
}

// POST helper
async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

// Generate from text
generateBtn.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) return alert("Vui lòng nhập văn bản hoặc upload file/URL trước.");
  const type = taskSelect.value;

  setLoading(true);
  try {
    const j = await postJSON("/api/process", { inputType: "text", text, type });
    if (j.success) {
      resultBox.innerHTML = escapeHtml(j.output);
      meta.textContent = `Model: ${j.model || "gemini-2.0-flash"}`;
    } else {
      resultBox.innerHTML = "❌ " + escapeHtml(j.error || "Unknown error");
    }
  } catch (e) {
    resultBox.innerHTML = "❌ Lỗi kết nối server";
  } finally { setLoading(false); }
});

// Upload file and get public link
uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) return alert("Chưa chọn file.");
  const fd = new FormData();
  fd.append("file", file);

  setLoading(true);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (j.success) {
      fileInfo.innerHTML = `File uploaded. <a href="${j.fileUrl}" target="_blank">Open file</a> — <button id="copyLinkBtn">Copy link</button>`;
      document.getElementById("copyLinkBtn").addEventListener("click", async () => {
        await navigator.clipboard.writeText(j.fileUrl);
        alert("Copied file link to clipboard");
      });
      if (j.extractedText) {
        textInput.value = j.extractedText.slice(0, 20000); // paste extracted to textarea
      }
    } else {
      fileInfo.textContent = "❌ Upload failed: " + (j.error || "");
    }
  } catch (e) {
    fileInfo.textContent = "❌ Upload error";
  } finally { setLoading(false); }
});

// Fetch URL and generate directly
fetchUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return alert("Nhập URL.");
  const type = taskSelect.value;
  setLoading(true);
  try {
    const j = await postJSON("/api/process", { inputType: "url", url, type });
    if (j.success) {
      resultBox.innerHTML = escapeHtml(j.output);
      meta.textContent = `Model: ${j.model || "gemini-2.0-flash"}`;
    } else {
      resultBox.innerHTML = "❌ " + escapeHtml(j.error || "Unknown error");
    }
  } catch (e) {
    resultBox.innerHTML = "❌ Lỗi kết nối";
  } finally { setLoading(false); }
});

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/[&<>"'`]/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;', '`':'&#96;'
  })[c]);
}
