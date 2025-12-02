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

// Upload file setup
const upload = multer({ dest: "uploads/" });

// PDF to text
async function extractTextPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

// 🔥 CALL GEMINI v1beta (chỉ cách này luôn chạy được)
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(json.error?.message || "Gemini API error");
  }

  return json.candidates[0].content.parts[0].text;
}

// API main
app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let input = "";

    if (req.file) {
      input = await extractTextPDF(req.file.path);
      fs.unlinkSync(req.file.path);
    } else if (req.body.text) {
      input = req.body.text;
    } else if (req.body.url) {
      input = await fetch(req.body.url).then(r => r.text());
    }

    let type = req.body.type;
    let prompt = "";

    switch (type) {
      case "summary":
        prompt = `Tóm tắt đoạn văn sau:\n${input}`;
        break;
      case "flashcards":
        prompt = `Tạo flashcards dạng JSON:\n${input}`;
        break;
      case "qa":
        prompt = `Tạo 10 câu hỏi và trả lời từ nội dung:\n${input}`;
        break;
      case "mindmap":
        prompt = `Tạo mindmap JSON từ nội dung:\n${input}`;
        break;
      default:
        prompt = input;
    }

    const output = await callGemini(prompt);

    res.json({ success: true, output });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Start server
app.listen(3000, () => console.log("🚀 Server chạy tại port 3000"));
