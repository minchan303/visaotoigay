const genBtn = document.getElementById("generateBtn");
const uploadBtn = document.getElementById("uploadBtn");
const ocrBtn = document.getElementById("ocrBtn");
const fetchBtn = document.getElementById("fetchBtn");

uploadBtn.onclick = () => {
  const file = document.getElementById("file").files[0];
  if (!file) return alert("Chọn file trước.");
  document.getElementById("uploadInfo").innerHTML = "File đã sẵn sàng để gửi.";
};

ocrBtn.onclick = async () => {
  const file = document.getElementById("file").files[0];
  if (!file) return alert("Chọn file trước.");

  document.getElementById("uploadInfo").innerHTML = "Đang OCR...";

  const result = await Tesseract.recognize(file, "eng", {});
  document.getElementById("text").value = result.data.text;

  document.getElementById("uploadInfo").innerHTML = "OCR xong!";
};

fetchBtn.onclick = async () => {
  generate(true);
};

genBtn.onclick = () => {
  generate(false);
};

async function generate(useURL) {
  const text = document.getElementById("text").value;
  const mode = document.getElementById("mode").value;
  const url = document.getElementById("url").value;

  const form = new FormData();
  form.append("mode", mode);
  form.append("text", text);
  form.append("url", useURL ? url : "");

  const file = document.getElementById("file").files[0];
  if (file) form.append("file", file);

  const response = await fetch("/api/generate", {
    method: "POST",
    body: form,
  });

  const data = await response.json();
  const resultDiv = document.getElementById("result");

  if (mode === "mindmap") {
    resultDiv.innerHTML = `<pre>${data.text}</pre>`;
  } else {
    resultDiv.innerHTML = data.text.replace(/\n/g, "<br>");
  }
}
