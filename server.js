import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import fetch from "node-fetch";
import sanitizeHtml from "sanitize-html";
import bodyParser from "body-parser";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS });

// AI KEY
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Strip HTML
function cleanHtml(html) {
  return sanitizeHtml(html, { allowedTags: [] }).replace(/\s+/g, " ").trim();
}

// Extract file text
async function extractText(filePath, ext) {
  if (ext === ".pdf") {
    const data = await pdf(fs.readFileSync(filePath));
    return data.text || "";
  }
  if (ext === ".docx") {
    const data = await mammoth.extractRawText({ path: filePath });
    return data.value || "";
  }
  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }
  return "";
}

// Mindmap → Image prompt
function createMindmapImagePrompt(content) {
  return `
You are a visual mindmap generator.

Create a clean, minimalist **mindmap diagram image** based on the following content.

Use clear branches, good spacing, and readable labels.

CONTENT:
${content}

Generate ONLY an image.`;
}

// Gemini text call
async function geminiText(prompt) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// Gemini image generation
async function geminiImage(prompt) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const result = await model.generateContent({
    prompt,
    generationConfig: { responseMimeType: "image/png" }
  });

  const img = result.response.candidates[0].content.parts[0].inlineData.data;
  return img;
}

// API: upload file
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const text = await extractText(req.file.path, ext);

    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}${ext}`;
    fs.renameSync(req.file.path, path.join(UPLOADS, req.file.filename + ext));

    res.json({ success: true, fileUrl: publicUrl, extractedText: text });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// API: main process
app.post("/api/process", async (req, res) => {
  try {
    const { mode, inputType, text, fileUrl, url } = req.body;
    let content = "";

    // INPUT: TEXT
    if (inputType === "text") content = text;

    // INPUT: URL
    if (inputType === "url") {
      const raw = await fetch(url).then(r => r.text());
      content = cleanHtml(raw).slice(0, 20000);
    }

    // INPUT: FILE
    if (inputType === "file") {
      const filename = fileUrl.split("/").pop();
      con
