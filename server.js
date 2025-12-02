import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

// ====== QUAN TRỌNG: Serve thư mục /public ======
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));

// ====== Route trang chính ======
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// Upload file
const upload = multer({ dest: "uploads/" });

// Extract text from PDF
async function extractTextPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text;
}

async function runGemini(prompt) {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ====== API xử lý ======
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
        prompt = `Tóm tắt ngắn gọn:\n${inputText}`;
        break;
      case "mindmap":
        prompt = `Tạo mindmap JSON từ:\n${inputText}`;
        break;
      case "flashcards":
        prompt = `Tạo flashcards JSON từ:\n${inputText}`;
        break;
      case "qa":
        prompt = `Tạo bộ câu hỏi & trả lời từ:\n${inputText}`;
        break;
      default:
        prompt = `Tóm tắt:\n${inputText}`;
    }

    const output = await runGemini(prompt);

    res.json({ success: true, output });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Server start
app.listen(3000, () => {
  console.log("Server chạy trên port 3000");
});



