import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const upload = multer({ dest: "uploads/" });

async function extractTextPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

// === CALL GEMINI PRO VIA API v1beta ===
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=" + apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(result));
  }

  return result.candidates[0].content.parts[0].text;
}

// ===== MAIN API =====
app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let inputText = "";
    const type = req.body.type;

    if (req.file) {
      inputText = await extractTextPDF(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    if (req.body.text) inputText = req.body.text;

    if (req.body.url) {
      const html = await fetch(req.body.url).then(r => r.text());
      inputText = html;
    }

    let prompt = "";

    switch (type) {
      case "summary":
        prompt = `Tóm tắt đoạn văn sau:\n\n${inputText}`;
        break;

      case "mindmap":
        prompt = `Tạo mindmap JSON từ nội dung sau:\n\n${inputText}`;
        break;

      case "flashcards":
        prompt = `Tạo flashcards JSON từ nội dung:\n\n${inputText}`;
        break;

      case "qa":
        prompt = `Tạo bộ câu hỏi & trả lời từ văn bản:\n\n${inputText}`;
        break;

      default:
        prompt = `Tóm tắt:\n${inputText}`;
    }

    const output = await callGemini(prompt);

    res.json({ success: true, output });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("Server chạy trên port 3000 (API DIRECT)"));
