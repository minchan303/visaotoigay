import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import pdf from "pdf-parse";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// serve public and current directory as fallback so index.html is found
app.use(express.static("public"));
app.use(express.static("."));

const upload = multer({ dest: "uploads/" });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function runGemini(prompt) {
  const result = await model.generateContent({ prompt });
  // library shape may vary — try to return text safely
  if (!result) return "";
  if (result.output?.[0]?.content?.[0]?.text) return result.output[0].content[0].text;
  if (result.response?.text) return result.response.text();
  if (result.text) return result.text;
  return JSON.stringify(result);
}

async function extractText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdf(dataBuffer);
  return data.text;
}

app.post("/api/process", upload.single("file"), async (req, res) => {
  try {
    let text = req.body.text || "";
    // accept either key 'type' or 'task'
    const type = req.body.type || req.body.task;

    if (req.file) {
      text = await extractText(req.file.path);
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    if (req.body.url && req.body.url.trim()) {
      const url = req.body.url.trim();
      const resp = await fetch(url);
      text = await resp.text();
    }

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

      default:
        // fallback: if no type, just ask to summarize
        prompt = `Tóm tắt nội dung sau:\n\n${text}`;
    }

    const output = await runGemini(prompt);
    res.json({ success: true, output });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Study Assistant Gemini API Running on ${PORT}`));
