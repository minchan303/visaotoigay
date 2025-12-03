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
import XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";

// OCR
import Tesseract from "tesseract.js";

// PDF exporter
import PDFDocument from "pdfkit";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* =============================
   OCR PDF (SCAN)
============================= */
async function ocrPdf(filePath) {
  const buffer = fs.readFileSync(filePath);

  const result = await Tesseract.recognize(buffer, "vie+eng", {
    logger: m => console.log("[OCR]", m)
  });

  return result.data.text;
}

/* =============================
   TEXT EXTRACTION
============================= */
async function extractText(filePath, ext) {
  try {
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
      if (!data.text.trim()) {
        console.log("PDF SCAN → OCR");
        return await ocrPdf(filePath);
      }
      return data.text;
    }

    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    if (ext === ".txt") {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch (err) {
    return await ocrPdf(filePath);
  }

  return "";
}

/* =============================
   SPREADSHEET
============================= */
function parseSpreadsheet(fp, ext) {
  const buf = fs.readFileSync(fp);

  if (ext === ".csv") {
    return csvParse(buf.toString(), { columns: true, skip_empty_lines: true });
  }

  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

function detectGradeSheet(rows) {
  if (!rows.length) return false;
  const keys = Object.keys(rows[0]).join(" ").toLowerCase();
  return ["điểm", "score", "grade"].some(k => keys.includes(k));
}

/* =============================
   GEMINI
============================= */
async function askGemini(prompt) {
  const model = genAI.getGenerativeModel({
    model: "models/gemini-2.0-flash"
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
}

/* =============================
   ROUTES: UPLOAD
============================= */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  const ext = path.extname(req.file.originalname);
  const newFile = req.file.path + ext;

  fs.renameSync(req.file.path, newFile);

  let text = "";
  let table = null;

  if ([".csv", ".xls", ".xlsx"].includes(ext)) {
    table = parseSpreadsheet(newFile, ext);
  } else {
    text = await extractText(newFile, ext);
  }

  res.json({
    success: true,
    fileUrl: "/uploads/" + path.basename(newFile),
    extractedText: text,
    parsedTable: table,
    isGradeSheet: table ? detectGradeSheet(table) : false
  });
});

/* =============================
   ROUTES: PROCESS
============================= */
app.post("/api/process", async (req, res) => {
  let { inputType, text, url, fileUrl, mode } = req.body;
  let content = "";

  // Determine input
  if (inputType === "text") content = text;
  if (inputType === "url") {
    const r = await fetch(url);
    content = sanitizeHtml(await r.text(), { allowedTags: [] });
  }
  if (inputType === "file") {
    const fp = path.join(UPLOADS, path.basename(fileUrl));
    const ext = path.extname(fp);

    if ([".csv", ".xls", ".xlsx"].includes(ext)) {
      const rows = parseSpreadsheet(fp, ext);
      if (detectGradeSheet(rows)) {
        return res.json({
          success: true,
          type: "chart",
          chart: {
            labels: rows.map(r => r[Object.keys(r)[0]]),
            datasets: [
              {
                label: "Điểm",
                data: rows.map(r => Number(r[Object.keys(r)[1]]) || 0)
              }
            ]
          }
        });
      }

      content = JSON.stringify(rows, null, 2);
    } else {
      content = await extractText(fp, ext);
    }
  }

  /* ===================
     MODE HANDLING
  ===================== */

  if (mode === "summary") {
    const output = await askGemini(`
Tóm tắt nội dung đẹp:
• Ngắn gọn
• Có bullet
• Dễ đọc
Nội dung:
${content}
`);
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "flashcards") {
    const output = await askGemini(`
Tạo flashcards đẹp:
[
  {"q": "...", "a": "..."}
]
Nội dung:
${content}
`);
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "qa") {
    const output = await askGemini(`
Tạo danh sách câu hỏi – trả lời đẹp:

Câu hỏi 1:
Trả lời 1

Câu hỏi 2:
Trả lời 2

Nội dung:
${content}
`);
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "learning_sections") {
    const output = await askGemini(`
Chia bài giảng thành từng mục học rõ ràng:

1. Chủ đề
- Mô tả
- Ý chính

2. Chủ đề
...

Nội dung:
${content}
`);
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "mindmap_text") {
    const out = await askGemini(`
TRẢ VỀ DUY NHẤT 1 JSON:

{
  "json": {
    "title": "...",
    "nodes": [
      {"label":"...", "children":[...]}
    ]
  },
  "text": "• ... mindmap bullet ..."
}

Nội dung:
${content}
`);
    return res.json({
      success: true,
      type: "mindmap_text",
      output: JSON.parse(out.match(/\{[\s\S]+\}/)[0])
    });
  }
});

/* =============================
   EXPORT PDF (optional)
============================= */
app.post("/api/export/pdf", (req, res) => {
  const { text } = req.body;

  const doc = new PDFDocument();
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  doc.fontSize(14).text(text, { align: "left" });
  doc.end();
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running")
);
