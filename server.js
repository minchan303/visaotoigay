import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import pdf from "pdf-parse";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static("."));   // QUAN TRỌNG: cho phép index.html load script nội bộ

const upload = multer({ dest: "uploads/" });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function runGemini(prompt) {
  const r = await model.generateContent(prompt);
  return r.response.text();
}

async function extractText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdf(dataBuffer);
  return data.text;
}

app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let text = req.body.text || "";
    const type = req.body.type;

    if (req.file) {
      text = await extractText(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    if (req.body.url) {
      const html = await fetch(req.body.url).then(r => r.text());
      text = html;
    }

    let prompt;
    switch (type) {
      case "summary":   prompt = `Tóm tắt nội dung sau:\n${text}`; break;
      case "flashcards":prompt = `Tạo flashcards JSON từ:\n${text}`; break;
      case "mindmap":   prompt = `Tạo mindmap JSON từ nội dung:\n${text}`; break;
      case "qa":        prompt = `Tạo câu hỏi & trả lời dựa trên:\n${text}`; break;
      default:          prompt = `Tóm tắt:\n${text}`;
    }

    const output = await runGemini(prompt);
    res.json({ output });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Server OK"));
