/**
 * server.js — resilient Gemini model loader
 *
 * Usage:
 * 1) Đặt GEMINI_API_KEY trong Render env variables
 * 2) Đặt file frontend vào /public (index.html, script.js, style.css)
 * 3) Start command: node server.js
 *
 * Behavior:
 * - Khi xử lý request, server sẽ thử lần lượt `modelCandidates`
 *   cho tới khi một model trả được kết quả (generateContent).
 * - Ghi log chi tiết để bạn biết model nào khả dụng.
 */

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

const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Multer setup for file upload
const upload = multer({ dest: "uploads/" });

// Instantiate client
if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY không được đặt. Vui lòng set env var trên Render.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Danh sách tên model khả dĩ (sắp xếp theo ưu tiên).
// Tùy vào version client / API, một số tên có thể hợp lệ hoặc không.
// Mình đưa nhiều lựa chọn để 'thử và chọn'.
const modelCandidates = [
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-pro-latest",
  "gemini-1.5-flash-latest",
  "gemini-1.0",
  // fallback models in case the env/client supports older names
  "text-bison@001",
  "chat-bison@001"
];

// Helper: extract text from PDF
async function extractTextPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text || "";
}

// Try to generate with a given model object and prompt.
// Returns { ok:true, text } on success or { ok:false, err } on failure.
async function tryGenerateWithModel(modelName, prompt) {
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    // generateContent signature may vary depending on client version; try common shapes:
    const result = await model.generateContent({ prompt });
    // Best-effort extract text from result object:
    if (!result) return { ok: false, err: new Error("Empty result") };

    // different lib shapes: result.output[0].content[0].text or result.response.text()
    if (result.output?.[0]?.content?.[0]?.text) {
      return { ok: true, text: result.output[0].content[0].text };
    }
    if (typeof result.response?.text === "function") {
      const t = await result.response.text();
      return { ok: true, text: t };
    }
    if (result.text) return { ok: true, text: result.text };
    // fallback: stringify whole result
    return { ok: true, text: JSON.stringify(result) };
  } catch (err) {
    return { ok: false, err };
  }
}

// Core: pick a model from candidates that works for this prompt
async function pickWorkingModelAndGenerate(prompt) {
  const errors = [];
  for (const name of modelCandidates) {
    console.log(`Thử model: ${name} ...`);
    const gen = await tryGenerateWithModel(name, prompt);
    if (gen.ok) {
      console.log(`Model hợp lệ: ${name}`);
      return { model: name, text: gen.text, errors };
    } else {
      console.warn(`Model ${name} failed:`, gen.err?.message || gen.err);
      // record brief message
      errors.push({ model: name, message: gen.err?.message || String(gen.err) });
      // nếu error rõ ràng 404 hoặc model not found, tiếp tục thử model khác
    }
  }
  return { model: null, text: null, errors };
}

// API endpoint
app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let inputText = "";
    const type = req.body.type || req.body.task || "summary";

    if (req.file) {
      inputText = await extractTextPDF(req.file.path);
      try { fs.unlinkSync(req.file.path); } catch {}
    } else if (req.body.text) {
      inputText = req.body.text;
    } else if (req.body.url) {
      const html = await fetch(req.body.url).then(r => r.text());
      inputText = html;
    }

    // basic prompt creation
    let prompt = "";
    switch (type) {
      case "summary":
        prompt = `Tóm tắt ngắn gọn nội dung sau:\n\n${inputText}`;
        break;
      case "flashcards":
        prompt = `Tạo flashcards (JSON array of {q,a}) từ nội dung:\n\n${inputText}`;
        break;
      case "qa":
        prompt = `Tạo danh sách câu hỏi & trả lời dựa trên nội dung:\n\n${inputText}`;
        break;
      case "mindmap":
        prompt = `Tạo mindmap JSON (name/children) từ nội dung:\n\n${inputText}`;
        break;
      default:
        prompt = `Tóm tắt nội dung:\n\n${inputText}`;
    }

    // pick model and generate
    const { model, text, errors } = await pickWorkingModelAndGenerate(prompt);

    if (!model) {
      console.error("Không tìm được model phù hợp. Chi tiết lỗi:", errors);
      return res.status(500).json({
        success: false,
        error:
          "Không có model hợp lệ cho generateContent. Xem logs server để biết model nào đã thử và lỗi là gì.",
        details: errors
      });
    }

    // success
    return res.json({ success: true, modelUsed: model, output: text });

  } catch (err) {
    console.error("Unhandled error:", err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server chạy trên port ${PORT}`);
});
