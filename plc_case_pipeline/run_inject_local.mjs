import fs from "node:fs";

const target = process.argv[2];
const scriptPath = process.argv[3];
const rubricPath = process.argv[4];
if (!target || !scriptPath || !rubricPath) {
  throw new Error("usage: run_inject_local.mjs TARGET_URL SCRIPT_MD RUBRIC_MD");
}
const authorization = process.env.PLC_AUTHORIZATION || "";
const cookie = process.env.PLC_COOKIE || "";
if (!authorization || !cookie) throw new Error("missing PLC credentials in environment");

const body = {
  trainTaskId: target,
  credentials: { authorization, cookie },
  scriptMarkdown: fs.readFileSync(scriptPath, "utf8"),
  rubricMarkdown: fs.readFileSync(rubricPath, "utf8"),
  extractionMode: "regex",
  injectMode: "replace",
  injectCoverImage: false,
  injectBackgroundImage: false,
  digitalHumanAvatarMode: "existing",
};

const response = await fetch("http://localhost:3000/api/training-inject", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
  body: JSON.stringify(body),
});
console.error(`HTTP ${response.status}`);
if (!response.body) throw new Error("empty response body");
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  process.stdout.write(decoder.decode(value, { stream: true }));
}
