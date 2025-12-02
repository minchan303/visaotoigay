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

// ================= Gemini INIT =================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAX_TEXT = 18000;
const CLEAN_HTML = (html) =>
  sanitizeHtml(html, { allowedTags: [] }).replace(/\s+/g, " ").trim();

// ================= FILE EXTRACT =================
async function extractText(filePath, ext) {
  try {
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
  } catch {
    return "";
  }
}

// ================= GEMINI TEXT =================
async function geminiText(prompt) {
  const model = genAI.getGenerativeModel({
    model: "models/gemini-2.0-flash",
  });

  const result = await model.generateContent(prompt);
  return result.response.text();
}


// ================= GEMINI IMAGE (MINDMAP) =================
// Google Gemini ONLY supports image generation via generateContent()
// with responseMimeType = "image/png"
async function geminiMindmap(content) {
  const model = genAI.getGenerativeModel({
    model: "models/gemini-2.0-flash",
  });

  const prompt = `
Tạo mindmap dạng hình ảnh (PNG), đẹp, rõ ràng. Chỉ trả về ảnh.
Nội dung cần tạo mindmap:
${content}
`;

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "image/png",
    },
  });

  // Result trả về dưới dạng base64
  const base64 = result.response.candidates[0].content.parts[0].inlineData.data;

  return base64;
}



// ================= UPLOAD FILE =================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);

    const text = await extractText(newPath, ext);
    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}${ext}`;

    res.json({
      success: true,
      fileUrl: publicUrl,
      extractedText: text,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ================= MAIN PROCESS =================
app.post("/api/process", async (req, res) => {
  try {
    let { mode, inputType, text, url, fileUrl } = req.body;
    let content = "";

    // TEXT mode
    if (inputType === "text") content = text || "";

    // URL mode
    if (inputType === "url") {
      try {
        const raw = await fetch(url).then((r) => r.text());
        content = CLEAN_HTML(raw);
      } catch {
        return res.json({
          success: false,
          error: "Không thể lấy dữ liệu từ URL.",
        });
      }
    }

    // FILE mode
    if (inputType === "file") {
      const filename = fileUrl.split("/").pop();
      const filePath = path.join(UPLOADS, filename);
      const ext = path.extname(filename);
      content = await extractText(filePath, ext);
    }

    // Validate
    if (!content.trim()) {
      return res.json({ success: false, error: "Không có nội dung hợp lệ." });
    }

    content = content.slice(0, MAX_TEXT);

    // ===== SUMMARY =====
    if (mode === "summary") {
      const output = await geminiText(`Tóm tắt nội dung sau:\n${content}`);
      return res.json({ success: true, type: "text", output });
    }

    // ===== FLASHCARDS =====
    if (mode === "flashcards") {
      const output = await geminiText(
        `Tạo flashcards dạng JSON [{q, a}] từ nội dung sau:\n${content}`
      );
      return res.json({ success: true, type: "text", output });
    }

    // ===== Q&A =====
    if (mode === "qa") {
      const output = await geminiText(
        `Tạo danh sách Q&A dạng JSON [{q, a}] từ nội dung sau:\n${content}`
      );
      return res.json({ success: true, type: "text", output });
    }

    // ===== MINDMAP IMAGE =====
    if (mode === "mindmap") {
      const base64 = await geminiMindmap(content);
      return res.json({
        success: true,
        type: "image",
        image: "data:image/png;base64," + base64,
      });
    }

    return res.json({ success: false, error: "Mode không hợp lệ." });
  } catch (e) {
    console.error("SERVER ERROR:", e);
    res.json({ success: false, error: e.message });
  }
});


// ================= STATIC =================
app.use("/uploads", express.static("uploads"));

app.listen(3000, () =>
  console.log("🚀 Gemini Chatbot server running on port 3000")
);
