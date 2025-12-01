import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import pdf from "pdf-parse";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function runGemini(prompt) {
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function extractText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdf(dataBuffer);
  return data.text;
}

app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let text = req.body.text || "";

    if (req.file) {
      text = await extractText(req.file.path);
      fs.unlinkSync(req.file.path);
    }

    if (req.body.url && req.body.url.trim()) {
      const url = req.body.url.trim();
      const resp = await fetch(url);
      text = await resp.text();
    }

    const type = req.body.type;

    let prompt = "";

    switch (type) {
      case "summary":
        prompt = `Tóm tắt nội dung sau thật ngắn gọn và dễ hiểu:\n\n${text}`;
        break;

      case "flashcards":
        prompt = `Tạo flashcards dạng JSON cho nội dung sau:\n${text}`;
        break;

      case "mindmap":
        prompt = `
Tạo MINDMAP ở dạng JSON với format:
{
  "name": "Root",
  "children": [
    { "name": "Ý chính 1", "children": [...] },
    { "name": "Ý chính 2", "children": [...] }
  ]
}
Nội dung: ${text}
`;
        break;

      case "qa":
        prompt = `Tạo danh sách câu hỏi & trả lời dựa trên nội dung sau:\n${text}`;
        break;
    }

    const output = await runGemini(prompt);
    res.json({ success: true, output });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("AI Study Assistant Gemini API Running"));
