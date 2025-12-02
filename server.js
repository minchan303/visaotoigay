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
app.use(bodyParser.json({ limit: "30mb" }));
app.use(express.static("public"));

const __dirname = path.resolve();
const UPLOADS = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const upload = multer({ dest: UPLOADS, limits: { fileSize: 25 * 1024 * 1024 } });

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

    const extractedText = await extractText(newPath, ext);
    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(newFilename)}`;

    res.json({ success: true, fileUrl: publicUrl, extractedText });
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
      const ext = path.extname(filename);
      content = await extractText(filePath, ext);
    } else {
      return res.json({ success: false, error: "Invalid inputType" });
    }

    if (!content || content.trim().length === 0) {
      return res.json({ success: false, error: "Không có nội dung để xử lý." });
    }

    // truncate
    const MAX = 18000;
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

    // NEW: mindmap_text mode -> textual mindmap (hierarchical bullets) and JSON
    if (mode === "mindmap_text") {
      // ask AI to return both a textual bullet mindmap and a JSON structure
      const prompt = `Phân tích nội dung sau và trả về hai phần (PHẢI CHỈ TRẢ 1) JSON đầu tiên (key "json") và sau đó phần text mindmap (key "text") dưới định dạng JSON duy nhất. Cấu trúc JSON cần có:
{
  "json": { "title": "...", "nodes": [ { "label":"...", "children":[ ... ] } ] },
  "text": "• Root\n  - Child A\n    * Sub A1\n..."
}
Trả tiếng Việt. Nội dung:\n\n${truncated}`;

      const out = await geminiText(prompt);

      // try to parse: extract outermost JSON object
      const match = out.match(/(\{[\s\S]*\})/);
      if (!match) {
        return res.json({ success: false, error: "AI không trả JSON. Nội dung trả về: " + out });
      }
      const jsonText = match[1];
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (e) {
        return res.json({ success: false, error: "Không parse được JSON từ AI. Output: " + out });
      }

      return res.json({ success: true, type: "mindmap_text", output: parsed });
    }

    // PRIOR mindmap_json mode: AI returns structured JSON (existing flow)
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
