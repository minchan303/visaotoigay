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

// Upload PDF
const upload = multer({ dest: "uploads/" });

// Extract text
async function extractPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

// ----------------------------------------
// GEMINI v1beta (model: gemini-1.0-pro)
// ----------------------------------------
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }] }
        ]
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "Gemini API error");
  }

  return result.candidates[0].content.parts[0].text;
}

// ----------------------------------------
// API PROCESSING
// ----------------------------------------
app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let text = "";

    if (req.file) {
      text = await extractPDF(req.file.path);
      fs.unlinkSync(req.file.path);
    } else if (req.body.text) {
      text = req.body.text;
    } else if (req.body.url) {
      text = await fetch(req.body.url).then(r => r.text());
    }

    const type = req.body.type;
    let prompt = "";

    switch (type) {
      case "summary":
        prompt = `Tóm tắt ngắn gọn:\n${text}`;
        break;
      case "flashcards":
        prompt = `Tạo flashcards (JSON) từ nội dung:\n${text}`;
        break;
      case "qa":
        prompt = `Tạo 10 câu hỏi và câu trả lời từ nội dung:\n${text}`;
        break;
      case "mindmap":
        prompt = `Tạo mindmap JSON từ:\n${text}`;
        break;
      default:
        prompt = text;
    }

    const output = await callGemini(prompt);

    res.json({ success: true, output });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Start server
app.listen(3000, () => console.log("🚀 Server chạy port 3000 (gemini-1.0-pro)"));
