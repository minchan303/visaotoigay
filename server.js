/**
 * server.js
 * - Serve frontend (public/)
 * - Upload files (uploads/) and provide public links
 * - Extract text from PDF, DOCX, TXT
 * - Fetch URL content (strip HTML)
 * - Call Gemini 2.0 Flash via @google/generative-ai
 *
 * NOTE: Set GEMINI_API_KEY in environment (Render -> Env Vars)
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";
import bodyParser from "body-parser";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "30mb" }));

const __dirname = path.resolve();
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");

// ensure uploads folder
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// serve static
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// multer for file upload
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

// initialize Gemini client (AI Studio key)
if (!process.env.GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY not set. Set it in environment variables.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// helper: extract text from PDF
async function extractTextFromPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text || "";
}

// helper: extract from docx
async function extractTextFromDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || "";
}

// helper: read txt
async function extractTextFromTxt(filePath) {
  const buf = fs.readFileSync(filePath, "utf8");
  return buf || "";
}

// helper: strip html (simple)
function stripHtml(html) {
  // remove scripts/styles and tags
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Call Gemini 2.0 Flash via library
async function generateWithGemini(prompt) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  // library returns object with response.text() in many versions
  const result = await model.generateContent({ prompt });
  // try to extract text
  if (result?.response?.text) {
    // some shapes expose response.text() as function
    if (typeof result.response.text === "function") {
      return await result.response.text();
    }
    return result.response.text;
  }
  if (result?.output?.[0]?.content?.[0]?.text) {
    return result.output[0].content[0].text;
  }
  // fallback stringfy
  return JSON.stringify(result);
}

// POST /api/upload -> upload file, return public URL and extracted text (optional)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

    const orig = req.file.originalname || req.file.filename;
    const savedPath = req.file.path;
    const ext = path.extname(orig).toLowerCase();

    let extracted = "";

    if (ext === ".pdf") {
      extracted = await extractTextFromPDF(savedPath);
    } else if (ext === ".docx" || ext === ".doc") {
      extracted = await extractTextFromDocx(savedPath);
    } else if (ext === ".txt") {
      extracted = await extractTextFromTxt(savedPath);
    } else {
      extracted = "";
    }

    // create a friendly public filename (avoid spaces)
    const publicName = encodeURIComponent(req.file.filename + path.extname(orig));
    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${publicName}`;

    // rename the saved file to include original extension for serving
    const destPath = path.join(UPLOADS_DIR, publicName);
    fs.renameSync(savedPath, destPath);

    res.json({ success: true, fileUrl: publicUrl, extractedText: extracted });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/process -> body: { inputType: "text"|"url"|"file", text?, url?, fileUrl?, type:task }
app.post("/api/process", async (req, res) => {
  try {
    const { inputType, text, url, fileUrl, type } = req.body;

    let content = "";

    if (inputType === "text") {
      content = (text || "").trim();
    } else if (inputType === "url") {
      if (!url) return res.status(400).json({ success: false, error: "Missing url" });
      // fetch and strip
      const fetched = await fetch(url, { timeout: 15000 }).then(r => r.text());
      content = stripHtml(fetched).slice(0, 20000); // limit
    } else if (inputType === "file") {
      // fileUrl should be absolute to our uploads
      if (!fileUrl) return res.status(400).json({ success: false, error: "Missing fileUrl" });
      // derive file path
      const urlObj = new URL(fileUrl, `${req.protocol}://${req.get("host")}`);
      const filename = path.basename(urlObj.pathname);
      const full = path.join(UPLOADS_DIR, filename);
      if (!fs.existsSync(full)) return res.status(400).json({ success: false, error: "Uploaded file not found" });
      const ext = path.extname(filename).toLowerCase();
      if (ext === ".pdf") content = await extractTextFromPDF(full);
      else if (ext === ".docx" || ext === ".doc") content = await extractTextFromDocx(full);
      else if (ext === ".txt") content = await extractTextFromTxt(full);
      else content = "";
    } else {
      return res.status(400).json({ success: false, error: "Invalid inputType" });
    }

    if (!content) return res.status(400).json({ success: false, error: "No content to process" });

    // build prompt based on 'type'
    let prompt = "";
    switch ((type || "summary").toLowerCase()) {
      case "summary":
        prompt = `Tóm tắt ngắn gọn nội dung sau, bằng tiếng Việt:\n\n${content}`;
        break;
      case "flashcards":
        prompt = `Tạo flashcards JSON (mảng {q,a}) từ nội dung sau, tiếng Việt:\n\n${content}`;
        break;
      case "qa":
        prompt = `Tạo danh sách câu hỏi và trả lời (JSON mảng {q,a}) từ nội dung sau:\n\n${content}`;
        break;
      case "mindmap":
        prompt = `Tạo mindmap JSON structure {name,children} từ nội dung sau:\n\n${content}`;
        break;
      default:
        prompt = content;
    }

    // call gemini
    const output = await generateWithGemini(prompt);

    // return output
    res.json({ success: true, model: "gemini-2.0-flash", output });
  } catch (err) {
    console.error("Process error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
