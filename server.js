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

const upload = multer({ dest: UPLOADS });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============ SPEED BOOST CONFIG ============
const MAX_TEXT = 18000; // giảm xuống để xử lý nhanh hơn
const CLEAN_HTML = (html) => sanitizeHtml(html, { allowedTags: [] }).replace(/\s+/g, " ").trim();

// ============ FILE EXTRACTION ============
async function extractText(filePath, ext) {
  if (ext === ".pdf") {
    const data = await pdf(fs.readFileSync(filePath));
    return data.text || "";
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  }
  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }
  return "";
}

// ============ GEMINI TEXT ============
async function geminiText(prompt) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash"
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ============ GEMINI IMAGE (MINDMAP) ============
async function geminiMindmap(content) {
  const prompt = `
Bạn là AI chuyên tạo mindmap hình ảnh.

Yêu cầu:
- Sơ đồ tư duy rõ ràng, phong cách sạch, tối giản.
- Nhánh chính, nhánh phụ rõ ràng.
- Nội dung bằng tiếng Việt.
- Tạo MỘT hình PNG duy nhất.

Nội dung:
${content}
`;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-image"
  });

  const result = await model.generateImage({
    prompt,
    size: "1024x1024"
  });

  return result.images[0].data;
}

// ============ UPLOAD ============
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);

    const text = await extractText(newPath, ext);
    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}${ext}`;

    return res.json({
      success: true,
      fileUrl: publicUrl,
      extractedText: text
    });

  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ============ MAIN PROCESS ============
app.post("/api/process", async (req, res) => {
  try {
    let { mode, inputType, text, url, fileUrl } = req.body;
    let content = "";

    // TEXT INPUT
    if (inputType === "text") content = text;

    // URL INPUT
    if (inputType === "url") {
      try {
        const raw = await fetch(url).then(r => r.text());
        content = CLEAN_HTML(raw);
      } catch {
        return res.json({
          success: false,
          error: "Không thể fetch URL này (có thể website chặn bot)."
        });
      }
    }

    // FILE INPUT
    if (inputType === "file") {
      const filename = fileUrl.split("/").pop();
      const filePath = path.join(UPLOADS, filename);
      const ext = path.extname(filename);
      content = await extractText(filePath, ext);
    }

    if (!content.trim()) {
      return res.json({ success: false, error: "Không có nội dung để xử lý." });
    }

    // SPEED BOOST: truncate để xử lý nhanh hơn
    content = content.slice(0, MAX_TEXT);

    // ========== MODES ==========
    if (mode === "summary") {
      const prompt = `
Tóm tắt văn bản sau theo cách cô đọng, tối ưu tốc độ xử lý.
Nội dung:  
${content}
`;
      const output = await geminiText(prompt);
      return res.json({ success: true, type: "text", output });
    }

    if (mode === "flashcards") {
      const prompt = `
Tạo flashcards dạng JSON [{q, a}] dựa trên nội dung sau, trả lời bằng tiếng Việt:
${content}
`;
      const output = await geminiText(prompt);
      return res.json({ success: true, type: "text", output });
    }

    if (mode === "qa") {
      const prompt = `
Tạo danh sách Q&A dạng JSON [{q, a}] dựa trên nội dung sau:
${content}
`;
      const output = await geminiText(prompt);
      return res.json({ success: true, type: "text", output });
    }

    if (mode === "mindmap") {
      const base64 = await geminiMindmap(content);
      return res.json({
        success: true,
        type: "image",
        image: "data:image/png;base64," + base64
      });
    }

    return res.json({ success: false, error: "Mode không hợp lệ." });

  } catch (e) {
    console.error(e);
    return res.json({ success: false, error: e.message });
  }
});

app.use("/uploads", express.static("uploads"));
app.listen(3000, () => console.log("🚀 Server chạy port 3000"));
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
      const filePath = path.join(UPLOADS, filename);
      const ext = path.extname(filename).toLowerCase();
      content = await extractText(filePath, ext);
    }

    // ---------- AI MODES ----------
    if (mode === "summary") {
      const prompt = `Tóm tắt nội dung sau bằng tiếng Việt:\n\n${content}`;
      const output = await geminiText(prompt);
      return res.json({ success: true, output, type: "text" });
    }

    if (mode === "flashcards") {
      const prompt = `Tạo flashcards JSON (mảng {q,a}) từ nội dung sau:\n\n${content}`;
      const output = await geminiText(prompt);
      return res.json({ success: true, output, type: "text" });
    }

    if (mode === "qa") {
      const prompt = `Tạo danh sách câu hỏi và trả lời JSON từ nội dung sau:\n\n${content}`;
      const output = await geminiText(prompt);
      return res.json({ success: true, output, type: "text" });
    }

    if (mode === "mindmap") {
      const imgPrompt = createMindmapImagePrompt(content);
      const base64 = await geminiImage(imgPrompt);

      return res.json({
        success: true,
        type: "image",
        image: `data:image/png;base64,${base64}`
      });
    }

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.use("/uploads", express.static(UPLOADS));

app.listen(3000, () => console.log("Server running on port 3000"));

