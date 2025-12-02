const modeRadios = document.querySelectorAll("input[name='mode']");
const textInput = document.getElementById("textInput");
const fileInput = document.getElementById("fileInput");
const urlInput = document.getElementById("urlInput");
const output = document.getElementById("output");
const taskSelect = document.getElementById("task");
const generateBtn = document.getElementById("generate");

// Switch mode
modeRadios.forEach(r => {
  r.addEventListener("change", () => {
    const mode = document.querySelector("input[name='mode']:checked").value;

    textInput.classList.add("hidden");
    fileInput.classList.add("hidden");
    urlInput.classList.add("hidden");

    if (mode === "text") textInput.classList.remove("hidden");
    if (mode === "file") fileInput.classList.remove("hidden");
    if (mode === "url") urlInput.classList.remove("hidden");
  });
});

// Generate
generateBtn.addEventListener("click", async () => {
  const mode = document.querySelector("input[name='mode']:checked").value;
  const task = taskSelect.value;

  output.textContent = "Đang xử lý...";

  try {
    let response;

    if (mode === "text") {
      response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputType: "text",
          text: textInput.value,
          type: task
        })
      });

    } else if (mode === "url") {
      response = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputType: "url",
          url: urlInput.value,
          type: task
        })
      });

    } else if (mode === "file") {
      const form = new FormData();
      form.append("file", fileInput.files[0]);
      form.append("type", task);

      response = await fetch("/api/process", {
        method: "POST",
        body: form
      });
    }

    const data = await response.json();

    if (data.error) output.textContent = "❌ Error: " + data.error;
    else output.textContent = data.output;

  } catch (e) {
    output.textContent = "❌ Lỗi kết nối đến server\n" + e.message;
  }
});
