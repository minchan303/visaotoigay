async function processText() {
  const text = document.getElementById("textInput").value;
  const mode = document.getElementById("mode").value;

  showLoading();

  const res = await fetch("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputType: "text",
      mode,
      text
    })
  }).then(r => r.json());

  showResult(res);
}

async function processURL() {
  const url = document.getElementById("urlInput").value;
  const mode = document.getElementById("mode").value;

  showLoading();

  const res = await fetch("/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputType: "url",
      mode,
      url
    })
  }).then(r => r.json());

  showResult(res);
}

async function uploadFile() {
  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Chọn file trước.");

  showLoading();

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api/upload", {
    method: "POST",
    body: fd
  }).then(r => r.json());

  if (res.success) {
    document.getElementById("textInput").value = res.extractedText;
    document.getElementById("fileStatus").innerHTML =
      `Uploaded: <a href="${res.fileUrl}" target="_blank">${res.fileUrl}</a>`;
  } else {
    document.getElementById("fileStatus").innerText = "Upload thất bại.";
  }
}

function showLoading() {
  document.getElementById("result").innerHTML = "⏳ Đang xử lý…";
}

function showResult(res) {
  if (!res.success) {
    document.getElementById("result").innerHTML = "❌ " + res.error;
    return;
  }

  if (res.type === "image") {
    document.getElementById("result").innerHTML =
      `<img src="${res.image}" style="max-width:100%;">`;
    return;
  }

  document.getElementById("result").innerText = res.output;
}
