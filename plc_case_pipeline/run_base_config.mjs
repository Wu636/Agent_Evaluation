import fs from "node:fs";

const target = process.argv[2];
const scriptPath = process.argv[3];
if (!target || !scriptPath) throw new Error("usage: run_base_config.mjs TARGET_URL SCRIPT_MD");
const authorization = process.env.PLC_AUTHORIZATION || "";
const cookie = process.env.PLC_COOKIE || "";
if (!authorization || !cookie) throw new Error("missing PLC credentials in environment");

const markdown = fs.readFileSync(scriptPath, "utf8");
const name = markdown.match(/^- \*\*任务名称\*\*:\s*(.+)$/m)?.[1]?.trim() || "PLC能力训练";
const description = markdown.match(/^- \*\*任务描述\*\*:\s*(.+)$/m)?.[1]?.trim() || "";
const body = {
  trainTaskId: target,
  credentials: { authorization, cookie },
  targetType: "cover",
  updateFullConfiguration: true,
  trainTaskName: name,
  trainDescription: description,
  coverStylePrompt: "工业自动化与PLC实训课程封面，专业写实、蓝色科技感、PLC控制柜与梯形图元素、16:9横版，无文字水印",
};
const response = await fetch("http://localhost:3000/api/training-inject/regenerate-image", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const text = await response.text();
console.log(JSON.stringify({ status: response.status, response: (() => { try { return JSON.parse(text); } catch { return text.slice(0, 500); } })() }));
