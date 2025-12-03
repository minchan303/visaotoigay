import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { convert } from "html-to-text";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

// ====================== GOOGLE GEMINI ======================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ====================== URL TEXT ===========================
async function extractTextFromURL(url) {
  try {
    const html = await (await fetch(url)).text();
    const clean = convert(html, { wordwrap: false });
    return clean;
  } catch (err) {
    return "Không thể tải URL.";
  }
}

// ====================== FILE PARSER ===========================
async function extractTextFromFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".pdf") {
    const buffer = fs.readFileSync(file.path);
    const data = await pdf(buffer);
    return data.text;
  }

  if (ext === ".docx") {
    const buffer = fs.readFileSync(file.path);
    const out = await mammoth.extractRawText({ buffer });
    return out.value;
  }

  if (ext === ".csv") {
    const raw = fs.readFileSync(file.path, "utf8");
    return raw;
  }

  return fs.readFileSync(file.path, "utf8");
}

// ====================== API MAIN ===========================
app.post("/api/generate", upload.single("file"), async (req, res) => {
  try {
    let inputText = req.body.text || "";

    if (req.body.url && req.body.url.trim() !== "") {
      inputText = await extractTextFromURL(req.body.url.trim());
    }

    if (req.file) {
      const parsed = await extractTextFromFile(req.file);
      inputText += "\n" + parsed;
    }

    const prompt = `
Bạn là chatbot HappyUni. Dựa trên nội dung sau hãy tạo kết quả theo chế độ: ${req.body.mode}

Nội dung:
${inputText}
    `;

    const result = await model.generateContent(prompt);
    const outputText = result.response.text();

    res.json({ text: outputText });

  } catch (err) {
    console.error(err);
    res.json({ text: "Lỗi server." });
  }
});

// ======================
app.listen(3000, () => console.log("Server running on port 3000"));
