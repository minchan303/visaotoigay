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

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS });

if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️ WARNING: GEMINI_API_KEY is missing!");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/*--------------------------------------
  HELPER FUNCTIONS
--------------------------------------*/

async function extractText(filePath, ext) {
  try {
    ext = ext.toLowerCase();
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
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
    console.error(e);
  }
  return "";
}

function parseSpreadsheet(filePath, ext) {
  const buffer = fs.readFileSync(filePath);

  if (ext === ".csv") {
    return csvParse(buffer.toString(), {
      columns: true,
      skip_empty_lines: true
    });
  }

  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

function detectGradeSheet(rows) {
  if (!rows || !rows.length) return false;
  const keys = Object.keys(rows[0]).map(x => x.toLowerCase());

  const match = ["điểm", "score", "point", "grade"];
  return keys.some(k => match.some(m => k.includes(m)));
}

async function askGemini(prompt) {
  const model = genAI.getGenerativeModel({ model: "models/gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

/*--------------------------------------
  UPLOAD FILE
--------------------------------------*/
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: "Không có file" });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const newFile = req.file.path + ext;
  fs.renameSync(req.file.path, newFile);

  let extractedText = "";
  let parsedTable = null;
  let isGradeSheet = false;

  if ([".csv", ".xlsx", ".xls"].includes(ext)) {
    parsedTable = parseSpreadsheet(newFile, ext);
    isGradeSheet = detectGradeSheet(parsedTable);
  } else {
    extractedText = await extractText(newFile, ext);
  }

  res.json({
    success: true,
    fileUrl: "/uploads/" + path.basename(newFile),
    extractedText,
    parsedTable,
    isGradeSheet
  });
});

/*--------------------------------------
  PROCESS
--------------------------------------*/
app.post("/api/process", async (req, res) => {
  try {
    const { inputType, text, url, fileUrl, mode } = req.body;
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
    if (inputType === "file" && fileUrl) {
      const filePath = path.join(UPLOADS, path.basename(fileUrl));
      const ext = path.extname(filePath).toLowerCase();

      if ([".csv", ".xlsx", ".xls"].includes(ext)) {
        const rows = parseSpreadsheet(filePath, ext);

        if (detectGradeSheet(rows)) {
          const labels = rows.map(r => r[Object.keys(r)[0]]);
          const values = rows.map(r => Number(r[Object.keys(r)[1]]));

          return res.json({
            success: true,
            type: "chart",
            chart: {
              labels,
              datasets: [
                { label: "Điểm", data: values }
              ]
            }
          });
        }

        content = JSON.stringify(rows, null, 2);
      } else {
        content = await extractText(filePath, ext);
      }
    }

    if (!content || content.length === 0)
      return res.json({ success: false, error: "Không có nội dung" });

    /* ---------------- MODE HANDLING ----------------*/
    if (mode === "summary") {
      const output = await askGemini("Tóm tắt ngắn gọn nội dung:\n" + content);
      return res.json({ success: true, type: "text", output });
    }

    if (mode === "flashcards") {
      const output = await askGemini(
        "Tạo flashcards dạng JSON (q,a) từ nội dung:\n" + content
      );
      return res.json({ success: true, type: "text", output });
    }

    if (mode === "qa") {
      const output = await askGemini(
        "Tạo danh sách câu hỏi & trả lời dạng JSON từ nội dung:\n" + content
      );
      return res.json({ success: true, type: "text", output });
    }

    if (mode === "mindmap_text") {
      const out = await askGemini(`
Phân tích nội dung và TRẢ VỀ DUY NHẤT 1 JSON:
{
  "json": {...},
  "text": "• Mindmap dạng bullet"
}
Nội dung:
${content}`);

      const match = out.match(/\{[\s\S]+\}/);
      if (!match) return res.json({ success: false, error: "Không parse được JSON" });

      return res.json({
        success: true,
        type: "mindmap_text",
        output: JSON.parse(match[0])
      });
    }

    res.json({ success: false, error: "Mode không hợp lệ" });

  } catch (e) {
    console.error(e);
    res.json({ success: false, error: e.message });
  }
});

/*--------------------------------------
  STATIC FILES
--------------------------------------*/
app.use("/uploads", express.static(UPLOADS));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Server running on port " + PORT)
);
