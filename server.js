// ===============================
//  IMPORTS
// ===============================
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { fileURLToPath } from "url";
import { dirname } from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import csvParser from "csv-parser";
import { PDFDocument } from "pdf-lib";
import { convert } from "html-to-text";

// Node 18+ đã có fetch → KHÔNG import node-fetch

// ===============================
//  PATH INIT
// ===============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ===============================
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

// ===============================
//  GOOGLE GEMINI
// ===============================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) console.error("❌ Missing GEMINI_API_KEY");

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ===============================
//  UTIL: EXTRACTORS
// ===============================
async function extractTextFromPDF(filePath) {
  const data = await pdf(fs.readFileSync(filePath));
  return data.text;
}

async function extractTextFromDocx(filePath) {
  const res = await mammoth.extractRawText({ path: filePath });
  return res.value;
}

async function extractTextFromCSV(filePath) {
  return new Promise((resolve) => {
    let text = "";
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on("data", (row) => {
        text += Object.values(row).join(" ") + "\n";
      })
      .on("end", () => resolve(text));
  });
}

async function extractTextFromURL(url) {
  try {
    const html = await (await fetch(url)).text();

    // Remove scripts & styles
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");

    // Remove all HTML tags
    cleaned = cleaned.replace(/<[^>]+>/g, " ");

    // Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned;

  } catch (err) {
    return "Không thể tải URL.";
  }
}

// ===============================
//  AI CONTENT GENERATION
// ===============================
async function generateAIOutput(mode, text) {
  let prompt = "";

  // ----------- SUMMARY -----------
  if (mode === "summary") {
    prompt = `
      Tóm tắt nội dung sau với văn phong rõ ràng, không dùng dấu *, không markdown:
      ${text}
    `;
  }

  // ----------- FLASHCARDS -----------
  else if (mode === "flashcards") {
    prompt = `
      Tạo flashcards theo định dạng JSON:
      [
        {"q": "Câu hỏi?", "a": "Trả lời"},
        ...
      ]
      KHÔNG markdown.
      Văn bản:
      ${text}
    `;
  }

  // ----------- Q&A -----------
  else if (mode === "qa") {
    prompt = `
      Tạo 6 câu hỏi + trả lời dựa trên nội dung dưới.
      Format:
      Q: ...
      A: ...
      KHÔNG dùng *, -, hoặc markdown.
      ${text}
    `;
  }

  // ----------- LEARNING SECTIONS -----------
  else if (mode === "learning_sections") {
    prompt = `
      Chia nội dung sau thành các mục học rõ ràng:
      ## Tiêu đề
      Nội dung...
      KHÔNG dùng ký hiệu *, -.
      ${text}
    `;
  }

  // ----------- MINDMAP -----------
  else if (mode === "mindmap_text") {
    prompt = `
      Bạn là AI tạo mindmap.

      Tạo mindmap dưới dạng JSON **thuần**, đúng cấu trúc:

      {
        "text": "Giải thích ngắn",
        "json": {
          "title": "Chủ đề chính",
          "nodes": [
            {
              "label": "Nhánh 1",
              "children": [
                {"label": "Ý 1"},
                {"label": "Ý 2"}
              ]
            }
          ]
        }
      }

      QUY TẮC:
      - CHỈ trả JSON. Không markdown, không thêm text.
      - KHÔNG dùng *, -, hoặc ký hiệu bullet.
      - JSON phải parse được.

      Văn bản:
      ${text}
    `;
  }

  // CALL GEMINI
  const aiRes = await model.generateContent(prompt);
  const raw = aiRes.response.text().trim();

  // Not mindmap → return as text
  if (mode !== "mindmap_text") {
    return { type: "text", output: raw };
  }

  // Mindmap must be JSON
  try {
    const jsonData = JSON.parse(raw);
    return {
      type: "mindmap_text",
      output: jsonData
    };
  } catch (e) {
    return {
      type: "text",
      output: "AI đã trả về JSON lỗi:\n" + raw
    };
  }
}

// ===============================
//  UPLOAD FILE
// ===============================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const fileUrl = "/uploads/" + file.filename;

    let extracted = "";
    let isGrade = false;

    // PDF
    if (file.mimetype.includes("pdf")) {
      extracted = await extractTextFromPDF(file.path);
      if (/score|grade|point/i.test(extracted)) isGrade = true;
    }

    // DOCX
    else if (file.originalname.endsWith(".docx")) {
      extracted = await extractTextFromDocx(file.path);
    }

    // CSV
    else if (file.mimetype.includes("csv")) {
      extracted = await extractTextFromCSV(file.path);
      isGrade = true;
    }

    res.json({
      success: true,
      fileUrl,
      extractedText: extracted,
      isGrade
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===============================
//  MAIN PROCESS
// ===============================
app.post("/api/process", async (req, res) => {
  try {
    const { mode, inputType, text, fileUrl, url } = req.body;

    let content = "";

    if (inputType === "text") content = text;
    else if (inputType === "url") content = await extractTextFromURL(url);
    else if (inputType === "file") {
      const local = path.join(__dirname, fileUrl);
      if (fileUrl.endsWith(".pdf")) content = await extractTextFromPDF(local);
      else if (fileUrl.endsWith(".docx")) content = await extractTextFromDocx(local);
      else if (fileUrl.endsWith(".csv")) content = await extractTextFromCSV(local);
    }

    const ai = await generateAIOutput(mode, content);
    res.json({ success: true, ...ai });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===============================
//  EXPORT PDF
// ===============================
app.post("/api/export/pdf", async (req, res) => {
  try {
    const { html } = req.body;

    const text = convert(html, {
      wordwrap: 120
    });

    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage([600, 800]);
    let y = 760;

    const lines = text.split("\n");
    for (const line of lines) {
      page.drawText(line, { x: 40, y, size: 12 });
      y -= 16;

      if (y < 50) {
        page = pdfDoc.addPage([600, 800]);
        y = 760;
      }
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.send(Buffer.from(pdfBytes));

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===============================
app.listen(3000, () => console.log("🚀 Server running on port 3000"));

