document.getElementById("generateBtn").addEventListener("click", async () => {
    const text = document.getElementById("inputText").value;
    const mode = document.getElementById("mode").value;
    const resultBox = document.getElementById("resultBox");

    resultBox.innerHTML = "⏳ Đang xử lý...";

    try {
        const res = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, mode })
        });

        const data = await res.json();

        if (data.error) {
            resultBox.innerHTML = "❌ " + data.error;
        } else {
            resultBox.innerHTML = data.result.replaceAll("\n", "<br>");
        }

    } catch (err) {
        resultBox.innerHTML = "❌ Lỗi kết nối server.";
    }
});
