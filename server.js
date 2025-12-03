import express from "express";
import cors from "cors";
import multer from "multer";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";
import PDFDocument from "pdfkit";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "60mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS });

let genAI = null;

if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} else {
  console.warn("⚠️ GEMINI_API_KEY chưa có → AI sẽ không chạy");
}

/* ------------------------------------------------
   READ TEXT FROM FILE
-------------------------------------------------- */

async function readText(filePath, ext) {
  try {
    if (ext === ".pdf") {
      const data = await pdfParse(fs.readFileSync(filePath));
      return data.text || "";
    }

    if (ext === ".docx") {
      const r = await mammoth.extractRawText({ path: filePath });
      return r.value || "";
    }

    if (ext === ".txt") {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch (err) {
    console.log("readText", err);
  }

  return "";
}

/* ------------------------------------------------
   READ SPREADSHEET
-------------------------------------------------- */
function readSheet(fp, ext) {
  const buf = fs.readFileSync(fp);
  if (ext === ".csv") {
    return csvParse(buf.toString(), { columns: true, skip_empty_lines: true });
  }

  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

function isGradeTable(rows) {
  if (!rows.length) return false;
  const keys = Object.keys(rows[0]).map(s => s.toLowerCase());
  return keys.some(k => ["score", "grade", "điểm", "diem"].some(x => k.includes(x)));
}

/* ------------------------------------------------
   GEMINI CALL
-------------------------------------------------- */
async function askGemini(prompt) {
  if (!genAI) return "GEMINI_API_KEY chưa được thiết lập.";
  try {
    const model = genAI.getGenerativeModel({ model: "models/gemini-2.0-flash" });

    const out = await model.generateContent(prompt);
    return out.response.text();
  } catch (e) {
    return "❌ Gemini lỗi: " + e.message;
  }
}

/* ------------------------------------------------
   UPLOAD FILE
-------------------------------------------------- */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  const ext = path.extname(req.file.originalname).toLowerCase();
  const newPath = req.file.path + ext;

  fs.renameSync(req.file.path, newPath);

  let text = "";
  let table = null;
  let grade = false;

  if ([".csv", ".xls", ".xlsx"].includes(ext)) {
    table = readSheet(newPath, ext);
    grade = isGradeTable(table);
  } else {
    text = await readText(newPath, ext);
  }

  res.json({
    success: true,
    fileUrl: "/uploads/" + path.basename(newPath),
    extractedText: text,
    parsedTable: table,
    isGrade: grade
  });
});

/* ------------------------------------------------
   PROCESS
-------------------------------------------------- */
app.post("/api/process", async (req, res) => {
  let { inputType, text, url, fileUrl, mode } = req.body;

  let content = "";

  if (inputType === "text") content = text;

  if (inputType === "url") {
    const r = await fetch(url);
    const html = await r.text();
    content = sanitizeHtml(html, { allowedTags: [] });
  }

  if (inputType === "file") {
    const filename = path.join(UPLOADS, path.basename(fileUrl));
    const ext = path.extname(filename);

    if ([".csv", ".xls", ".xlsx"].includes(ext)) {
      const rows = readSheet(filename, ext);
      if (isGradeTable(rows)) {
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
      content = await readText(filename, ext);
    }
  }

  const max = 20000;
  const truncated = content.slice(0, max);

  // MODES
  if (mode === "summary") {
    const output = await askGemini(
      `Tóm tắt đẹp, bullet, dễ đọc:\n\n${truncated}`
    );
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "flashcards") {
    const output = await askGemini(
      `Tạo flashcards (JSON array {q,a}) từ nội dung:\n${truncated}`
    );
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "qa") {
    const output = await askGemini(
      `Tạo Q&A rõ ràng từ nội dung:\n${truncated}`
    );
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "learning_sections") {
    const output = await askGemini(
      `Chia bài học thành từng section, mỗi section có tiêu đề + mô tả ngắn + 3 ý chính:\n${truncated}`
    );
    return res.json({ success: true, type: "text", output });
  }

  if (mode === "mindmap_text") {
    const out = await askGemini(
      `Trả 1 JSON dạng:
      {
        "json": { "title":"...", "nodes":[{"label":"...", "children":[...]}]},
        "text":"• bullet mindmap"
      }

      Nội dung:
      ${truncated}`
    );

    const jsonMatch = out.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ success: false, error: "Không parse JSON từ AI" });

    const parsed = JSON.parse(jsonMatch[0]);
    return res.json({ success: true, type: "mindmap_text", output: parsed });
  }

  res.json({ success: false, error: "Mode không hợp lệ" });
});

/* ------------------------------------------------
   EXPORT PDF
-------------------------------------------------- */
app.post("/api/export/pdf", (req, res) => {
  const { title, html } = req.body;

  res.setHeader("Content-Type", "application/pdf");

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  doc.fontSize(18).text(title, { align: "center" });
  doc.moveDown();

  const plain = sanitizeHtml(html, { allowedTags: [] });
  doc.fontSize(12).text(plain);

  doc.end();
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server is running!")
);
