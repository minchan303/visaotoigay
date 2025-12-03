// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import bodyParser from "body-parser";
import XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";
import PDFDocument from "pdfkit";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS });

const geminiApiKey = process.env.GEMINI_API_KEY || "";
let genAI = null;
if (geminiApiKey) {
  genAI = new GoogleGenerativeAI(geminiApiKey);
} else {
  console.warn("GEMINI_API_KEY not set; AI features that call Gemini will fail.");
}

// Helpers
async function extractTextFromFile(filePath, ext) {
  ext = ext.toLowerCase();
  try {
    if (ext === ".pdf") {
      const data = await pdfParse(fs.readFileSync(filePath));
      // If pdf-parse returns text -> use it. If empty, frontend OCR expected (we still return empty).
      return (data && data.text) ? data.text : "";
    }
    if (ext === ".docx") {
      const r = await mammoth.extractRawText({ path: filePath });
      return r.value || "";
    }
    if (ext === ".txt") {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch (e) {
    console.error("extractTextFromFile error:", e);
  }
  return "";
}

function parseSpreadsheet(filePath, ext) {
  const buffer = fs.readFileSync(filePath);
  if (ext === ".csv") {
    return csvParse(buffer.toString("utf8"), { columns: true, skip_empty_lines: true });
  } else {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: "" });
  }
}

function detectGradeSheet(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const headers = Object.keys(rows[0]).map(h => h.toLowerCase());
  const gradeKeywords = ["score", "grade", "mark", "điểm", "diem"];
  for (const kw of gradeKeywords) if (headers.some(h => h.includes(kw))) return true;

  // numeric column heuristic
  let numericCols = 0;
  for (const h of headers) {
    let numericCount = 0;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const v = rows[i][h];
      if (v === null || v === undefined) continue;
      const n = parseFloat(String(v).replace(",", "."));
      if (!Number.isNaN(n)) numericCount++;
    }
    if (numericCount >= Math.min(rows.length, 10) * 0.6) numericCols++;
  }
  return numericCols >= 1;
}

async function callGemini(prompt) {
  if (!genAI) throw new Error("Gemini API key not configured.");
  const model = genAI.getGenerativeModel({ model: "models/gemini-2.0-flash" });
  const resp = await model.generateContent({ contents: [{ parts: [{ text: prompt }] }] });
  // best-effort extract text
  if (resp.response?.text) return resp.response.text;
  if (resp.response?.candidates?.[0]?.content?.[0]?.text) return resp.response.candidates[0].content[0].text;
  return JSON.stringify(resp);
}

// Routes
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
    const orig = req.file.originalname || "file";
    const ext = path.extname(orig).toLowerCase();
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);

    let extractedText = "";
    let parsedTable = null;
    let isGrade = false;

    if ([".csv", ".xls", ".xlsx"].includes(ext)) {
      parsedTable = parseSpreadsheet(newPath, ext);
      isGrade = detectGradeSheet(parsedTable);
    } else {
      extractedText = await extractTextFromFile(newPath, ext);
    }

    const fileUrl = `/uploads/${path.basename(newPath)}`;
    res.json({ success: true, fileUrl, extractedText, parsedTable, isGrade });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/process", async (req, res) => {
  try {
    const { inputType, text, url, fileUrl, mode } = req.body;
    let content = "";

    if (inputType === "text") {
      content = text || "";
    } else if (inputType === "url") {
      if (!url) return res.status(400).json({ success: false, error: "Missing URL" });
      const r = await fetch(url);
      const html = await r.text();
      content = sanitizeHtml(html, { allowedTags: [] });
    } else if (inputType === "file") {
      if (!fileUrl) return res.status(400).json({ success: false, error: "Missing fileUrl" });
      const filename = path.basename(fileUrl);
      const filePath = path.join(UPLOADS, filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: "File not found" });
      const ext = path.extname(filePath).toLowerCase();
      if ([".csv", ".xls", ".xlsx"].includes(ext)) {
        const rows = parseSpreadsheet(filePath, ext);
        if (detectGradeSheet(rows)) {
          // build a simple chart dataset
          const headers = Object.keys(rows[0]);
          // pick label column (first non-numeric) and numeric value column
          let labelCol = headers.find(h => /name|student|tên|id/i.test(h)) || headers[0];
          let valueCol = headers.find(h => {
            for (let i = 0; i < Math.min(rows.length, 30); i++) {
              const v = rows[i][h];
              if (v === null || v === undefined) continue;
              if (!Number.isNaN(parseFloat(String(v).replace(",", ".")))) return true;
            }
            return false;
          }) || headers[1];

          const labels = rows.map(r => (r[labelCol] != null ? String(r[labelCol]) : ""));
          const data = rows.map(r => {
            const v = r[valueCol];
            const n = parseFloat(String(v).replace(",", "."));
            return Number.isNaN(n) ? 0 : n;
          });

          return res.json({ success: true, type: "chart", chart: { labels, datasets: [{ label: valueCol, data }] } });
        }
        content = JSON.stringify(rows.slice(0, 200), null, 2);
      } else {
        // For pdf files if pdf-parse returns empty, front-end OCR intended; still return whatever server can extract
        content = await extractTextFromFile(filePath, ext);
      }
    } else {
      return res.status(400).json({ success: false, error: "Invalid inputType" });
    }

    // truncate very long content for LLM
    const MAX = 20000;
    const truncated = content.slice(0, MAX);

    // Modes handling — call Gemini where needed
    if (mode === "summary") {
      const prompt = `Tóm tắt ngắn bằng tiếng Việt thành các bullet points đẹp:\n\n${truncated}`;
      const out = await callGemini(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    if (mode === "flashcards") {
      const prompt = `Tạo flashcards (JSON array of { "q": "...", "a": "..." }) từ nội dung sau, trả chỉ JSON:\n\n${truncated}`;
      const out = await callGemini(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    if (mode === "qa") {
      const prompt = `Tạo danh sách Q&A (câu hỏi & trả lời) từ nội dung sau. Trả định dạng rõ ràng:\n\n${truncated}`;
      const out = await callGemini(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    if (mode === "learning_sections") {
      const prompt = `Chia nội dung sau thành các mục học (learning sections) — mỗi mục gồm tiêu đề, mô tả ngắn và 3 ý chính:\n\n${truncated}`;
      const out = await callGemini(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    if (mode === "mindmap_text") {
      const prompt = `Phân tích nội dung và trả về DUY NHẤT 1 JSON: { "json": { "title":"...", "nodes":[{ "label":"...", "children":[...] }] }, "text":"•..." } (tiếng Việt). Nội dung:\n\n${truncated}`;
      const out = await callGemini(prompt);
      const match = out.match(/\{[\s\S]*\}/);
      if (!match) return res.json({ success: false, error: "AI không trả JSON" });
      try {
        const parsed = JSON.parse(match[0]);
        return res.json({ success: true, type: "mindmap_text", output: parsed });
      } catch (e) {
        return res.json({ success: false, error: "Không parse JSON từ AI" });
      }
    }

    return res.json({ success: false, error: "Mode không hợp lệ" });
  } catch (e) {
    console.error("process error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Export result to PDF (server-side)
app.post("/api/export/pdf", (req, res) => {
  try {
    const { title = "Result", html = "", text = "" } = req.body;
    res.setHeader("Content-Type", "application/pdf");
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    doc.fontSize(20).text(title, { align: "center" });
    doc.moveDown();

    if (html) {
      // simple convert: strip tags and print
      const plain = sanitizeHtml(html, { allowedTags: [] });
      doc.fontSize(12).text(plain);
    } else {
      doc.fontSize(12).text(text || "");
    }

    doc.end();
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.use("/uploads", express.static(UPLOADS));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));

