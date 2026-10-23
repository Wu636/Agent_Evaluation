const target = process.argv[2];
if (!target) throw new Error("usage: run_regenerate_all.mjs TARGET_URL");
const authorization = process.env.PLC_AUTHORIZATION || "";
const cookie = process.env.PLC_COOKIE || "";
if (!authorization || !cookie) throw new Error("missing PLC credentials in environment");

const response = await fetch("http://localhost:3000/api/training-inject/regenerate-image", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
  body: JSON.stringify({
    trainTaskId: target,
    credentials: { authorization, cookie },
    targetType: "all",
    coverStylePrompt: "工业自动化与PLC实训课程封面，专业写实、蓝色科技感、PLC控制柜与梯形图元素、16:9横版，无文字水印",
    backgroundStylePrompt: "专业写实的工业自动化与PLC实训场景，适合作为阶段卡片背景，16:9横版，无文字、无水印、无拼贴",
  }),
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
