import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const __dirname = path.resolve();

// 👉 Load API KEY
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post("/api/generate", async (req, res) => {
  try {
    const { text, mode } = req.body;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `Hãy thực hiện tác vụ: ${mode}\n\nNội dung:\n${text}`;

    const result = await model.generateContent(prompt);
    const output = await result.response.text();

    res.json({ result: output });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(3000, () => {
  console.log("Server chạy trên port 3000");
});
