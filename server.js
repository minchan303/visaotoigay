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
import Tesseract from "tesseract.js-node";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ============================================================
   ==========  OCR SCAN PDF  ==================================
===============================================================*/
async function ocrPdf(filePath) {
  const buffer = fs.readFileSync(filePath);

  const result = await Tesseract.recognize(buffer, "vie+eng", {
    logger: m => console.log("[OCR]: ", m)
  });

  return result.data.text;
}

/* ============================================================
   ==========  READ TEXT FILES  ===============================
===============================================================*/
async function extractText(filePath, ext) {
  ext = ext.toLowerCase();

  try {
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));

      // Nếu pdf-parse KHÔNG đọc được (PDF dạng scan)
      if (!data.text.trim()) {
        console.log("→ PDF scan, chuyển sang OCR");
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
  } catch (e) {
    console.log("extractText lỗi → fallback OCR");
    return await ocrPdf(filePath);
  }

  return "";
}

/* ============================================================
   ==========  SPREADSHEET  ===================================
===============================================================*/
function parseSpreadsheet(filePath, ext) {
  const buf = fs.readFileSync(filePath);

  if (ext === ".csv") {
    return csvParse(buf.toString(), { columns: true, skip_empty_lines: true });
  }

  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

function detectGradeSheet(rows) {
  if (!rows.length) return false;

  const keys = Object.keys(rows[0]).map(x => x.toLowerCase());
  const match = ["điểm", "diem", "score", "grade"];

  return keys.some(k => match.some(m => k.includes(m)));
}

/* ============================================================
   ==========   GEMINI API   ==================================
===============================================================*/
async function askGemini(prompt) {
  const model = genAI.getGenerativeModel({
    model: "models/gemini-2.0-flash"
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
}

/* ============================================================
   ==========   UPLOAD FILE   =================================
===============================================================*/
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.json({ success: false });

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

/* ============================================================
   ==========   PROCESS   =====================================
===============================================================*/
app.post("/api/process", async (req, res) => {
  try {
    let { inputType, text, url, fileUrl, mode } = req.body;
    let content = "";

    // TEXT
    if (inputType === "text") content = text;

    // URL
    if (inputType === "url") {
      const r = await fetch(url);
      const html = await r.text();
      content = sanitizeHtml(html, { allowedTags: [] });
    }

    // FILE
    if (inputType === "file") {
      const filePath = path.join(UPLOADS, path.basename(fileUrl));
      const ext = path.extname(filePath);

      if ([".csv", ".xls", ".xlsx"].includes(ext)) {
        const rows = parseSpreadsheet(filePath, ext);

        if (detectGradeSheet(rows)) {
          return res.json({
            success: true,
            type: "chart",
            chart: {
              labels: rows.map(r => r[Object.keys(r)[0]]),
              datasets: [
                {
                  label: "Điểm",
                  data: rows.map(r =>
                    Number(r[Object.keys(r)[1]]) || 0
                  )
                }
              ]
            }
          });
        }

        content = JSON.stringify(rows, null, 2);
      } else {
        content = await extractText(filePath, ext);
      }
    }

    /* ==================  FORMATTER ĐẸP  ================== */

    if (mode === "summary") {
      const output = await askGemini(`
Hãy tóm tắt nội dung sau thành 4–6 ý đẹp mắt.
• Dùng bullet gọn
• Viết rõ ràng, mạch lạc
• Tiếng Việt

Nội dung:
${content}
`);

      return res.json({ success: true, type: "text", output });
    }

    if (mode === "flashcards") {
      const output = await askGemini(`
Tạo flashcards đẹp dưới dạng JSON:
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
Tạo danh sách câu hỏi & trả lời rõ ràng.
Định dạng:

Câu hỏi 1:
Trả lời 1

Câu hỏi 2:
Trả lời 2

Nội dung:
${content}
`);

      return res.json({ success: true, type: "text", output });
    }

    if (mode === "mindmap_text") {
      const out = await askGemini(`
TRẢ VỀ DUY NHẤT 1 JSON SAU:

{
  "json": {
    "title": "...",
    "nodes": [ { "label":"...", "children":[...] } ]
  },
  "text": "• Mindmap dạng gạch đầu dòng đẹp"
}

Nội dung:
${content}
`);

      const json = out.match(/\{[\s\S]+\}/);
      return res.json({
        success: true,
        type: "mindmap_text",
        output: JSON.parse(json[0])
      });
    }

  } catch (e) {
    console.log(e);
    res.json({ success: false, error: e.message });
  }
});

/* ============================================================
   STATIC
===============================================================*/
app.use("/uploads", express.static(UPLOADS));

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
