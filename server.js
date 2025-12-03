// server.js
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
import { parse as csvParseSync } from "csv-parse/sync";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS, limits: { fileSize: 50 * 1024 * 1024 } });

if (!process.env.GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY not set in environment variables.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// helpers
const CLEAN_HTML = (html) =>
  sanitizeHtml(html || "", { allowedTags: [] }).replace(/\s+/g, " ").trim();

async function extractText(filePath, ext) {
  try {
    ext = ext.toLowerCase();
    if (ext === ".pdf") {
      const data = await pdf(fs.readFileSync(filePath));
      return data.text || "";
    }
    if (ext === ".docx" || ext === ".doc") {
      const r = await mammoth.extractRawText({ path: filePath });
      return r.value || "";
    }
    if (ext === ".txt") {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch (e) {
    console.error("extractText error:", e);
  }
  return "";
}

function parseSpreadsheet(filePath, ext) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (ext === ".csv") {
      const txt = buffer.toString("utf8");
      const records = csvParseSync(txt, { columns: true, skip_empty_lines: true });
      return records; // array of objects
    } else {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
      return json;
    }
  } catch (e) {
    console.error("parseSpreadsheet error:", e);
    return null;
  }
}

function detectGradeSheet(rows) {
  // rows: array of objects. Heuristic:
  // - header contains keywords like score/grade/mark/điểm
  // - or many numeric columns
  if (!Array.isArray(rows) || rows.length === 0) return { isGrade: false };
  const headers = Object.keys(rows[0]).map(h => (h || "").toString().toLowerCase());
  const gradeKeywords = ["score", "grade", "mark", "score%", "điểm", "diem", "tổng", "final"];
  for (const k of gradeKeywords) if (headers.some(h => h.includes(k))) return { isGrade: true };

  // count numeric columns
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
  return { isGrade: numericCols >= 1 };
}

async function geminiText(prompt) {
  const model = genAI.getGenerativeModel({ model: "models/gemini-2.0-flash" });
  const result = await model.generateContent({
    contents: [{ parts: [{ text: prompt }] }]
  });

  if (typeof result.response?.text === "function") return await result.response.text();
  if (result.response?.text) return result.response.text;
  const cand = result.response?.candidates?.[0]?.content?.[0]?.text;
  if (cand) return cand;
  return JSON.stringify(result);
}

// upload endpoint
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
    const orig = req.file.originalname || "file";
    const ext = path.extname(orig) || "";
    const newFilename = req.file.filename + ext;
    const newPath = path.join(UPLOADS, newFilename);
    fs.renameSync(req.file.path, newPath);

    // attempt to parse spreadsheets
    let parsedTable = null;
    let isGradeSheet = false;
    if ([".csv", ".xlsx", ".xls"].includes(ext.toLowerCase())) {
      const rows = parseSpreadsheet(newPath, ext.toLowerCase());
      if (rows) {
        parsedTable = rows;
        const det = detectGradeSheet(rows);
        isGradeSheet = !!det.isGrade;
      }
    }

    const extractedText = await extractText(newPath, ext);
    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(newFilename)}`;

    const resp = { success: true, fileUrl: publicUrl, extractedText };
    if (parsedTable) {
      resp.parsedTable = parsedTable;
      resp.isGradeSheet = isGradeSheet;
    }

    res.json(resp);
  } catch (e) {
    console.error("upload error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// process endpoint
app.post("/api/process", async (req, res) => {
  try {
    const { inputType, text, url, fileUrl, mode } = req.body;
    let content = "";

    let uploadedFileInfo = null;
    if (inputType === "text") {
      content = text || "";
    } else if (inputType === "url") {
      if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
        return res.json({ success: false, error: "URL không hợp lệ. Bắt đầu bằng http/https." });
      }
      try {
        const r = await fetch(url, { timeout: 15000 });
        if (!r.ok) return res.json({ success: false, error: `Fetch URL trả mã ${r.status}` });
        const html = await r.text();
        content = CLEAN_HTML(html);
      } catch (e) {
        console.error("fetch url error:", e);
        return res.json({ success: false, error: "Không thể fetch URL (bị chặn hoặc timeout)." });
      }
    } else if (inputType === "file") {
      if (!fileUrl) return res.json({ success: false, error: "Missing fileUrl" });
      const filename = decodeURIComponent(fileUrl.split("/").pop());
      const filePath = path.join(UPLOADS, filename);
      if (!fs.existsSync(filePath)) return res.json({ success: false, error: "Uploaded file not found" });
      const ext = path.extname(filename).toLowerCase();

      // if spreadsheet, parse and possibly return chart
      if ([".csv", ".xlsx", ".xls"].includes(ext)) {
        const rows = parseSpreadsheet(filePath, ext);
        if (!rows) return res.json({ success: false, error: "Không parse được file bảng." });

        const det = detectGradeSheet(rows);

        // build a simple chart: if there's a column that looks like "name" and one numeric col, use it
        const headers = Object.keys(rows[0]);
        // find first textual column for labels
        let labelCol = headers.find(h => /name|student|họ|tên|id/i.test(h)) || headers[0];
        // find first numeric column
        let valueCol = headers.find(h => {
          for (let i = 0; i < Math.min(rows.length, 30); i++) {
            const v = rows[i][h];
            if (v === null || v === undefined) continue;
            if (!Number.isNaN(parseFloat(String(v).replace(",", ".")))) return true;
          }
          return false;
        });

        if (det.isGrade && valueCol) {
          const labels = rows.map(r => (r[labelCol] != null ? String(r[labelCol]) : ""));
          const data = rows.map(r => {
            const v = r[valueCol];
            const n = parseFloat(String(v).replace(",", "."));
            return Number.isNaN(n) ? null : n;
          });

          return res.json({
            success: true,
            type: "chart",
            chart: {
              labels,
              datasets: [
                { label: valueCol, data }
              ]
            },
            meta: { parsedTable: rows.slice(0, 200), labelCol, valueCol }
          });
        }

        // If not grade or no numeric col, fallback to returning extracted text from sheet
        content = JSON.stringify(rows.slice(0, 200), null, 2);
        uploadedFileInfo = { parsedTable: rows };
      } else {
        // non-spreadsheet files: extract text
        const ext2 = path.extname(filePath);
        content = await extractText(filePath, ext2);
      }
    } else {
      return res.json({ success: false, error: "Invalid inputType" });
    }

    if (!content || content.trim().length === 0) {
      return res.json({ success: false, error: "Không có nội dung để xử lý." });
    }

    // truncate
    const MAX = 22000;
    const truncated = content.slice(0, MAX);

    // modes
    if (mode === "summary") {
      const prompt = `Tóm tắt ngắn gọn bằng tiếng Việt:\n\n${truncated}`;
      const out = await geminiText(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    if (mode === "flashcards") {
      const prompt = `Tạo flashcards dạng JSON array of {"q","a"} từ nội dung sau ( tiếng Việt ). Chỉ trả JSON:\n\n${truncated}`;
      const out = await geminiText(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    if (mode === "qa") {
      const prompt = `Tạo danh sách Q&A dạng JSON array of {"q","a"} từ nội dung sau ( tiếng Việt ). Chỉ trả JSON:\n\n${truncated}`;
      const out = await geminiText(prompt);
      return res.json({ success: true, type: "text", output: out });
    }

    // mindmap_text: AI returns a single JSON object containing both "json" and "text"
    if (mode === "mindmap_text") {
      const prompt = `Phân tích nội dung sau và trả về hai phần (PHẢI CHỈ TRẢ 1) JSON đầu tiên (key "json") và sau đó phần text mindmap (key "text") dưới định dạng JSON duy nhất. Cấu trúc JSON cần có:
{
  "json": { "title": "...", "nodes": [ { "label":"...", "children":[ ... ] } ] },
  "text": "• Root\\n  - Child A\\n    * Sub A1\\n..."
}
Trả tiếng Việt. Nội dung:\n\n${truncated}`;
      const out = await geminiText(prompt);
      const match = out.match(/(\{[\s\S]*\})/);
      if (!match) return res.json({ success: false, error: "AI không trả JSON. Output: " + out });
      try {
        const parsed = JSON.parse(match[1]);
        return res.json({ success: true, type: "mindmap_text", output: parsed });
      } catch (e) {
        return res.json({ success: false, error: "Không parse được JSON từ AI. Output: " + out });
      }
    }

    // mindmap (structured json)
    if (mode === "mindmap") {
      const prompt = `Phân tích nội dung sau và trả về CHỈ MỘT JSON mô tả mindmap với format:
{
  "title":"...",
  "nodes":[ { "label":"...","children":[ ... ] } ]
}
Trả tiếng Việt, chỉ output JSON. Nội dung:\n\n${truncated}`;
      const out = await geminiText(prompt);
      const m = out.match(/(\{[\s\S]*\})/);
      if (!m) return res.json({ success: false, error: "AI không trả JSON. Output: " + out });
      try {
        const parsed = JSON.parse(m[1]);
        return res.json({ success: true, type: "mindmap_json", output: parsed });
      } catch (e) {
        return res.json({ success: false, error: "Không parse JSON mindmap: " + e.message });
      }
    }

    return res.json({ success: false, error: "Mode không hợp lệ." });
  } catch (e) {
    console.error("PROCESS ERROR:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.use("/uploads", express.static(UPLOADS));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
