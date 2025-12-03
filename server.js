import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { fileURLToPath } from "url";
import { dirname } from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import csvParser from "csv-parser";
import { JSDOM } from "jsdom";
import { Readable } from "stream";
import { PDFDocument } from "pdf-lib";
import { convert } from "html-to-text";

// ------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ------------------------------

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

// ------------------------------
//  GOOGLE GEMINI
// ------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("❌ Missing GEMINI_API_KEY");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ------------------------------
//  UTILS
// ------------------------------
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
    const $ = cheerio.load(html);
    return $("body").text().replace(/\s+/g, " ").trim();
  } catch (e) {
    return "Không thể tải URL.";
  }
}

// ------------------------------
//  AI GENERATE CONTENT
// ------------------------------
async function generateAIOutput(mode, text) {
  let prompt = "";

  // ------------------ SUMMARY ------------------
  if (mode === "summary") {
    prompt = `
      Tóm tắt nội dung sau thành đoạn rõ ràng, sạch sẽ.
      Không dùng bullet "*".
      ${text}
    `;
  }

  // ------------------ FLASHCARDS ------------------
  else if (mode === "flashcards") {
    prompt = `
      Tạo danh sách flashcards theo JSON như sau:
      [
        {"q": "Câu hỏi?", "a": "Trả lời"},
        ...
      ]
      Không markdown. Chỉ JSON.
      Nội dung:
      ${text}
    `;
  }

  // ------------------ Q&A ------------------
  else if (mode === "qa") {
    prompt = `
      Tạo 6 câu hỏi và trả lời dựa trên văn bản.
      Format:
      Q: ...
      A: ...
      Không dùng ký hiệu "*" hoặc "-".
      Văn bản:
      ${text}
    `;
  }

  // ------------------ LEARNING SECTIONS ------------------
  else if (mode === "learning_sections") {
    prompt = `
      Chia nội dung sau thành các mục học (Learning Sections).
      Format:
      ## Tiêu đề
      Nội dung...
      Không dùng "*" hoặc "-" markdown.
      ${text}
    `;
  }

  // ------------------ MINDMAP JSON ------------------
  else if (mode === "mindmap_text") {
    prompt = `
      Bạn là AI tạo mindmap.

      Hãy tạo mindmap theo **định dạng JSON CHUẨN** sau:

      {
        "text": "Giải thích ngắn gọn nội dung mindmap",
        "json": {
          "title": "Chủ đề chính",
          "nodes": [
            {
              "label": "Nhánh 1",
              "children": [
                {"label": "Ý nhỏ 1"},
                {"label": "Ý nhỏ 2"}
              ]
            }
          ]
        }
      }

      QUY TẮC:
      - KHÔNG dùng *, -, hoặc markdown.
      - KHÔNG trả thêm bất kỳ chữ nào ngoài JSON.
      - JSON phải hợp lệ để parse.
      - Nội dung ngắn gọn, rõ ràng.

      VĂN BẢN:
      ${text}
    `;
  }

  // ------------------ CALL GEMINI ------------------
  const aiRes = await model.generateContent(prompt);
  const raw = aiRes.response.text().trim();

  // Nếu không phải mindmap → trả text
  if (mode !== "mindmap_text") {
    return {
      type: "text",
      output: raw
    };
  }

  // Mindmap cần JSON
  try {
    const jsonData = JSON.parse(raw);
    return {
      type: "mindmap_text",
      output: jsonData
    };
  } catch (e) {
    return {
      type: "text",
      output: "Mindmap JSON parse failed. AI trả về:\n" + raw
    };
  }
}

// ------------------------------
//  UPLOAD FILE
// ------------------------------
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const fileUrl = "/uploads/" + file.filename;
    let extracted = "";
    let isGrade = false;

    if (file.mimetype.includes("pdf")) {
      extracted = await extractTextFromPDF(file.path);
      if (/score|grade|point/i.test(extracted)) isGrade = true;
    } else if (file.mimetype.includes("word") || file.originalname.endsWith(".docx")) {
      extracted = await extractTextFromDocx(file.path);
    } else if (file.mimetype.includes("csv")) {
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

// ------------------------------
//  PROCESS (MAIN ENDPOINT)
// ------------------------------
app.post("/api/process", async (req, res) => {
  try {
    const { mode, inputType, text, fileUrl, url } = req.body;
    let content = "";

    if (inputType === "text") content = text;
    if (inputType === "url") content = await extractTextFromURL(url);
    if (inputType === "file") {
      const localPath = path.join(__dirname, fileUrl);
      if (fileUrl.endsWith(".pdf")) content = await extractTextFromPDF(localPath);
      else if (fileUrl.endsWith(".docx")) content = await extractTextFromDocx(localPath);
      else if (fileUrl.endsWith(".csv")) content = await extractTextFromCSV(localPath);
    }

    const ai = await generateAIOutput(mode, content);
    res.json({ success: true, ...ai });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ------------------------------
//  EXPORT PDF
// ------------------------------
app.post("/api/export/pdf", async (req, res) => {
  try {
    const { title, html } = req.body;

    const text = convert(html, {
      wordwrap: 130,
      selectors: [{ selector: "a", format: "inline" }]
    });

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    const fontSize = 12;
    let y = 760;

    const wrapped = text.split("\n");
    for (let line of wrapped) {
      page.drawText(line, { x: 40, y, size: fontSize });
      y -= 16;
      if (y < 40) {
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

// ------------------------------
app.listen(3000, () => console.log("🚀 Server running on port 3000"));
