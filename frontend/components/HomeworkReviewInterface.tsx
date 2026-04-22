"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  Upload, X, CheckCircle2, Loader2, FileDown, AlertCircle,
  Key, ChevronDown, ChevronUp, Settings2, Info, Terminal,
  Table2, FolderOpen, Clock, Trash2, Eye, EyeOff, RefreshCw, Type
} from "lucide-react";
import clsx from "clsx";
import { MODEL_NAME_MAPPING, normalizeModelId } from "@/lib/config";

const STORAGE_KEY = "homework-review-credentials";
const HISTORY_KEY = "homework-review-history";
const SESSION_STATE_KEY = "homework-review-session";
const MAX_HISTORY = 30;

const LEVEL_OPTIONS = ["优秀的回答", "良好的回答", "中等的回答", "合格的回答", "较差的回答"];

// 默认等级描述（与后端 LEVEL_DEFINITIONS 保持同步）
const DEFAULT_LEVEL_DEFINITIONS: Record<string, string> = {
  "优秀的回答": "知识全面精准，逻辑清晰连贯，案例结合到位，合规细节无遗漏",
  "良好的回答": "覆盖较全，逻辑较清晰，有一定案例结合，偶有小瑕疵",
  "中等的回答": "基本知识点掌握，逻辑一般，案例结合较少，表述平铺直叙",
  "合格的回答": "核心知识点有遗漏，逻辑不够严密，表述存在模糊之处",
  "较差的回答": "知识漏洞多，逻辑混乱，未结合案例，存在明显错误"
};

// ─── Session 持久化（刷新不丢失） ───
interface SessionState {
  mode: "generate" | "review" | "generate-and-review";
  generatedFiles: GeneratedAnswerFile[];
  generatedJobId: string;
  generatedOutputRoot: string;
  genPhase: "idle" | "generating" | "preview" | "reviewing";
  generateLogs: string[];
  reviewLogs: string[];
  genAndReviewLogs: string[];
  reviewResult: ReviewResult | null;
  genAndReviewResult: ReviewResult | null;
  selectedLevels: string[];
  generateInputMode: "file" | "text";
  genAndReviewInputMode: "file" | "text";
  generateTextContent: string;
  genAndReviewTextContent: string;
}

function saveSessionState(state: Partial<SessionState>) {
  try {
    const existing = loadSessionState();
    const merged = { ...existing, ...state };
    sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(merged));
  } catch { /* quota exceeded, ignore */ }
}

function loadSessionState(): SessionState | null {
  try {
    const data = sessionStorage.getItem(SESSION_STATE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

// ─── 历史记录 ───
interface ReviewHistoryItem {
  id: string;
  timestamp: string;
  fileNames: string[];
  attempts: number;
  jobId: string;
  scoreTable: ScoreTable;
}

function generateHistoryId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadHistory(): ReviewHistoryItem[] {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

function saveHistory(history: ReviewHistoryItem[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch { /* quota exceeded, ignore */ }
}

function addHistoryItem(item: ReviewHistoryItem) {
  const history = loadHistory();
  history.unshift(item);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  saveHistory(history);
}

function deleteHistoryItem(id: string) {
  const history = loadHistory().filter((h) => h.id !== id);
  saveHistory(history);
}

// ─── 评分表数据结构 ───
interface ScoreEntry {
  name: string;
  total?: number;
  scores: (number | null)[];
  mean: number | null;
  variance: number | null;
}

interface StudentScore {
  name: string;
  full_mark: number;
  total_scores: (number | null)[];
  mean: number | null;
  variance: number | null;
  categories: ScoreEntry[];
  questions?: ScoreEntry[];  // 逐题评分（详细展示用）
  dimensions: ScoreEntry[];
}

interface ScoreTable {
  attempts: number;
  students: StudentScore[];
}

interface ReviewResult {
  jobId: string;
  outputFiles: string[];
  summary: any;
  downloadBaseUrl: string;
  scoreTable: ScoreTable | null;
}

interface Credentials {
  authorization: string;
  cookie: string;
  instanceNid: string;
}

interface GeneratedAnswerFile {
  name: string;
  path: string;
  relative: string;
}

const getUploadedFileKey = (file: File) => file.name + file.size;
const getGeneratedFileKey = (file: GeneratedAnswerFile) => file.path || file.relative || file.name;

function loadCredentials(): Credentials {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return { authorization: "", cookie: "", instanceNid: "" };
}

function saveCredentials(creds: Credentials) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

function loadLLMSettings(): { apiKey: string; apiUrl: string; model: string } {
  try {
    const saved = localStorage.getItem("llm-eval-settings");
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        apiKey: parsed.apiKey || "",
        apiUrl: parsed.apiUrl || "",
        model: normalizeModelId(parsed.model),
      };
    }
  } catch { /* ignore */ }
  return { apiKey: "", apiUrl: "", model: "" };
}

/* ─── Fallback：从 summary.results 构建评分表（兼容旧版 Python 输出）─── */

function extractCoreData(result: any): {
  totalScore: number | null;
  fullMark: number;
  dimensionScores: any[];
  categoryScores: Record<string, { score: number; total: number }>;
  categoryOrder: string[];
  rawQuestionScores: { name: string; score: number; total: number }[];
} | null {
  if (!result || typeof result !== "object") return null;

  const reportData = result.data ?? result;
  let coreData: any = {};

  if (reportData?.artifacts?.length > 0) {
    const parts = reportData.artifacts[0]?.parts || [];
    coreData = parts[0]?.data || {};
  } else {
    coreData = typeof reportData === "object" ? reportData : {};
  }

  if (!coreData || typeof coreData !== "object") return null;
  if (!("totalScore" in coreData) && !("questionScores" in coreData)) return null;

  // 计算题型分
  const questionScores: any[] = coreData.questionScores || [];
  const catScores: Record<string, { score: number; total: number }> = {};
  const catOrder: string[] = [];
  const rawQs: { name: string; score: number; total: number }[] = [];

  for (const q of questionScores) {
    const cat = q.questionCategory || "未分类";
    if (!catScores[cat]) {
      catScores[cat] = { score: 0, total: 0 };
      catOrder.push(cat);
    }
    catScores[cat].score += q.questionScore ?? 0;
    catScores[cat].total += q.questionTotalScore ?? 0;
    // 保留逐题数据
    const qName = q.questionName || q.name || `${cat}(未命名)`;
    rawQs.push({ name: qName, score: q.questionScore ?? q.score ?? 0, total: q.questionTotalScore ?? q.totalScore ?? 0 });
  }

  // 计算真实满分：优先用各题 totalScore 之和
  const sumOfTotals = rawQs.reduce((acc, q) => acc + (q.total || 0), 0);
  const realFullMark = sumOfTotals > 0 ? sumOfTotals : (coreData.fullMark || 100);

  return {
    totalScore: coreData.totalScore ?? null,
    fullMark: realFullMark,
    dimensionScores: coreData.dimensionScores || [],
    categoryScores: catScores,
    categoryOrder: catOrder,
    rawQuestionScores: rawQs,
  };
}

function buildScoreTableFromSummary(summary: any): ScoreTable | null {
  try {
    const results: any[] = summary?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    const attempts = summary.attempts ?? Math.max(...results.map((r: any) => r.attempt_total ?? 1));
    const preparedFiles: string[] = summary.prepared_files || [];

    // 文件名映射
    const labelCounts: Record<string, number> = {};
    const labelByPath: Record<string, string> = {};
    for (const fp of preparedFiles) {
      if (labelByPath[fp]) continue;
      const stem = fp.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "未命名";
      labelCounts[stem] = (labelCounts[stem] || 0) + 1;
      labelByPath[fp] = labelCounts[stem] > 1 ? `${stem}(${labelCounts[stem]})` : stem;
    }

    // 分学生聚合
    const studentMap: Record<string, {
      fullMark: number;
      totalScores: (number | null)[];
      categories: Record<string, { scores: (number | null)[]; total: number }>;
      catOrder: string[];
      questions: Record<string, { scores: (number | null)[]; total: number }>;
      qOrder: string[];
      dimensions: Record<string, (number | null)[]>;
      dimOrder: string[];
    }> = {};

    for (const item of results) {
      if (!item?.success) continue;
      const core = extractCoreData(item.result);
      if (!core) continue;

      const fp = item.file_path || "";
      const stem = fp.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") || "未命名";
      const label = labelByPath[fp] || stem;
      const ai = item.attempt_index ?? 1;
      if (ai < 1 || ai > attempts) continue;

      if (!studentMap[label]) {
        studentMap[label] = {
          fullMark: core.fullMark,
          totalScores: Array(attempts).fill(null),
          categories: {},
          catOrder: [],
          questions: {},
          qOrder: [],
          dimensions: {},
          dimOrder: [],
        };
      }
      const entry = studentMap[label];
      entry.totalScores[ai - 1] = core.totalScore;

      for (const catName of core.categoryOrder) {
        if (!entry.categories[catName]) {
          entry.categories[catName] = { scores: Array(attempts).fill(null), total: 0 };
          entry.catOrder.push(catName);
        }
        const cat = core.categoryScores[catName];
        if (cat) {
          entry.categories[catName].scores[ai - 1] = cat.score;
          if (cat.total > entry.categories[catName].total) entry.categories[catName].total = cat.total;
        }
      }

      // 逐题评分
      for (const q of core.rawQuestionScores) {
        if (!q.name) continue;
        if (!entry.questions[q.name]) {
          entry.questions[q.name] = { scores: Array(attempts).fill(null), total: 0 };
          entry.qOrder.push(q.name);
        }
        entry.questions[q.name].scores[ai - 1] = q.score;
        if (q.total > entry.questions[q.name].total) entry.questions[q.name].total = q.total;
      }

      for (const dim of core.dimensionScores) {
        const dname = dim.evaluationDimension || "未命名维度";
        if (!entry.dimensions[dname]) {
          entry.dimensions[dname] = Array(attempts).fill(null);
          entry.dimOrder.push(dname);
        }
        entry.dimensions[dname][ai - 1] = dim.dimensionScore ?? null;
      }
    }

    const computeStats = (scores: (number | null)[]): { mean: number | null; variance: number | null } => {
      const valid = scores.filter((s): s is number => s != null);
      if (valid.length === 0) return { mean: null, variance: null };
      const mean = Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100;
      const variance = valid.length > 1
        ? Math.round((valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length) * 100) / 100
        : 0;
      return { mean, variance };
    };

    // 排序：优秀 → 良好 → 中等 → 合格 → 较差
    const levelOrder: Record<string, number> = { 优秀: 1, 良好: 2, 中等: 3, 合格: 4, 较差: 5 };
    const sortKey = (label: string) => {
      for (const [lv, pri] of Object.entries(levelOrder)) {
        if (label.includes(lv)) return pri;
      }
      return 999;
    };

    const students: StudentScore[] = Object.entries(studentMap)
      .sort(([a], [b]) => sortKey(a) - sortKey(b))
      .map(([label, entry]) => {
        const ts = computeStats(entry.totalScores);
        return {
          name: label,
          full_mark: entry.fullMark,
          total_scores: entry.totalScores,
          mean: ts.mean,
          variance: ts.variance,
          categories: entry.catOrder.map((cn) => {
            const ce = entry.categories[cn];
            const cs = computeStats(ce.scores);
            return { name: cn, total: ce.total, scores: ce.scores, mean: cs.mean, variance: cs.variance };
          }),
          questions: entry.qOrder.map((qn) => {
            const qe = entry.questions[qn];
            const qs = computeStats(qe.scores);
            return { name: qn, total: qe.total, scores: qe.scores, mean: qs.mean, variance: qs.variance };
          }),
          dimensions: entry.dimOrder.map((dn) => {
            const ds = entry.dimensions[dn];
            const st = computeStats(ds);
            return { name: dn, scores: ds, mean: st.mean, variance: st.variance };
          }),
        };
      });

    if (students.length === 0) return null;
    return { attempts, students };
  } catch {
    return null;
  }
}

export function HomeworkReviewInterface() {
  // Railway API 直连（绕过 Vercel 300秒超时限制）
  const RAILWAY_API = process.env.NEXT_PUBLIC_HOMEWORK_API_URL || "";

  // 从 sessionStorage 恢复上次会话状态
  const saved = useRef(loadSessionState());

  // 模式选择: generate=仅生成答案, review=批阅评测, generate-and-review=生成并评测
  const [mode, setMode] = useState<"generate" | "review" | "generate-and-review">(saved.current?.mode || "generate");
  const [selectedLevels, setSelectedLevels] = useState<string[]>(saved.current?.selectedLevels || LEVEL_OPTIONS);

  // 生成模式两步状态（跨 Tab 保留）
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedAnswerFile[]>(saved.current?.generatedFiles || []);
  const [generatedJobId, setGeneratedJobId] = useState<string>(saved.current?.generatedJobId || "");
  const [generatedOutputRoot, setGeneratedOutputRoot] = useState<string>(saved.current?.generatedOutputRoot || "");
  const [genPhase, setGenPhase] = useState<"idle" | "generating" | "preview" | "reviewing">(
    // 恢复时如果之前在 generating/reviewing 中间刷新了，回退到上一个稳定态
    saved.current?.genPhase === "generating" || saved.current?.genPhase === "reviewing"
      ? "idle"
      : saved.current?.genPhase || "idle"
  );

  // 文档预览状态
  const [previewingFile, setPreviewingFile] = useState<string | null>(null); // 正在预览的文件名
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);

  // 各 Tab 独立的上传文件状态（File 对象不可序列化，无法持久化）
  const [generateFiles, setGenerateFiles] = useState<File[]>([]);         // 生成答案 Tab 的题卷
  const [reviewFiles, setReviewFiles] = useState<File[]>([]);             // 批阅评测 Tab 的作业文件
  const [genAndReviewFiles, setGenAndReviewFiles] = useState<File[]>([]); // 生成并评测 Tab 的题卷
  const [generateInputMode, setGenerateInputMode] = useState<"file" | "text">(saved.current?.generateInputMode || "file");
  const [genAndReviewInputMode, setGenAndReviewInputMode] = useState<"file" | "text">(saved.current?.genAndReviewInputMode || "file");
  const [generateTextContent, setGenerateTextContent] = useState(saved.current?.generateTextContent || "");
  const [genAndReviewTextContent, setGenAndReviewTextContent] = useState(saved.current?.genAndReviewTextContent || "");

  // 每文件 LLM 校验跳过标记（上传文件用 name+size，生成文件用 server path）
  const [skipLLMFiles, setSkipLLMFiles] = useState<Set<string>>(new Set());

  // 文件分组：groupId → { name, fileKeys[] }，用于多文件合并为一份作业
  const [fileGroups, setFileGroups] = useState<Map<string, { name: string; fileKeys: string[] }>>(new Map());
  // 选中待合并的文件 key
  const [selectedForGroup, setSelectedForGroup] = useState<Set<string>>(new Set());

  // 生成答案 Prompt 模板（用户可编辑，通用化适配多种作业类型）
  const DEFAULT_GENERATE_PROMPT = `你是一名【{{level}}】水平的学生，正在作答《{{title}}》。
请根据你的水平要求完成所有题目或任务。

【等级要求：{{level}}】
{{level_desc}}

【作业内容】
{{exam_content}}

【输出要求】
1. 请自动识别作业类型（试卷、论文、报告、案例分析、实验报告等），并按照对应格式作答
2. 如果是试卷类作业：按题型分类作答，保持题号对应，选择题紧凑排列
3. 如果是论文/报告类作业：输出完整的、符合题意和字数要求的文章
4. 如果是案例分析类作业：结合案例进行分析论述
5. 不要包含任何多余的开场白、解释或元评论，直接输出答案内容
6. 答案的质量必须严格符合【{{level}}】水平的设定
7. 如果是较低等级，应体现出知识理解不深入、存在错误或遗漏等特征
8. 绝对禁止使用 LaTeX 语法（如 $...$ 、\\begin 、\\frac 等），所有数学公式必须用纯文本表示，例如：用 A^(-1) 代替 $A^{-1}$，用空格和竖线画矩阵而不是 \\begin{pmatrix}`;
  const [generatePromptTemplate, setGeneratePromptTemplate] = useState(DEFAULT_GENERATE_PROMPT);
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  // 等级描述定义（用户可自定义，例如调整分数范围）
  const [levelDefinitions, setLevelDefinitions] = useState<Record<string, string>>({ ...DEFAULT_LEVEL_DEFINITIONS });
  const [showLevelEditor, setShowLevelEditor] = useState(false);

  // 各 Tab 独立的结果/日志状态（从 session 恢复）
  const [generateLogs, setGenerateLogs] = useState<string[]>(saved.current?.generateLogs || []);
  const [reviewLogs, setReviewLogs] = useState<string[]>(saved.current?.reviewLogs || []);
  const [genAndReviewLogs, setGenAndReviewLogs] = useState<string[]>(saved.current?.genAndReviewLogs || []);

  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(saved.current?.reviewResult || null);
  const [genAndReviewResult, setGenAndReviewResult] = useState<ReviewResult | null>(saved.current?.genAndReviewResult || null);

  const [generateError, setGenerateError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [genAndReviewError, setGenAndReviewError] = useState<string | null>(null);

  // 按当前 mode 获取/设置文件、日志、结果、错误的便捷访问
  const files = mode === "generate" ? generateFiles : mode === "review" ? reviewFiles : genAndReviewFiles;
  const setFiles = mode === "generate" ? setGenerateFiles : mode === "review" ? setReviewFiles : setGenAndReviewFiles;
  const logs = mode === "generate" ? generateLogs : mode === "review" ? reviewLogs : genAndReviewLogs;
  const setLogs = mode === "generate" ? setGenerateLogs : mode === "review" ? setReviewLogs : setGenAndReviewLogs;
  const result = mode === "review" ? reviewResult : mode === "generate-and-review" ? genAndReviewResult : null;
  const setResult = mode === "review" ? setReviewResult : setGenAndReviewResult;
  const error = mode === "generate" ? generateError : mode === "review" ? reviewError : genAndReviewError;
  const setError = mode === "generate" ? setGenerateError : mode === "review" ? setReviewError : setGenAndReviewError;
  const inputMode = mode === "generate" ? generateInputMode : mode === "generate-and-review" ? genAndReviewInputMode : "file";
  const setInputMode = mode === "generate" ? setGenerateInputMode : mode === "generate-and-review" ? setGenAndReviewInputMode : null;
  const pastedText = mode === "generate" ? generateTextContent : mode === "generate-and-review" ? genAndReviewTextContent : "";
  const setPastedText = mode === "generate" ? setGenerateTextContent : mode === "generate-and-review" ? setGenAndReviewTextContent : null;

  const [attempts, setAttempts] = useState(5);
  const [outputFormat, setOutputFormat] = useState<"json" | "pdf">("json");
  const [localParse, setLocalParse] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState(5);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // 智慧树认证
  const [authorization, setAuthorization] = useState("");
  const [cookie, setCookie] = useState("");
  const [instanceNid, setInstanceNid] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // LLM 设置（从全局设置读取）
  const [llmInfo, setLlmInfo] = useState({ apiKey: "", apiUrl: "", model: "" });

  // 实时日志
  const logEndRef = useRef<HTMLDivElement>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 标记是否自动衔接批阅（生成并评测模式），防止 startReview 的 finally 过早清理
  const autoReviewTakenOverRef = useRef(false);

  // 历史记录
  const [historyList, setHistoryList] = useState<ReviewHistoryItem[]>([]);
  const [viewingHistory, setViewingHistory] = useState<ReviewHistoryItem | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // 刷新历史
  const refreshHistory = useCallback(() => {
    setHistoryList(loadHistory());
  }, []);

  useEffect(() => {
    const creds = loadCredentials();
    setAuthorization(creds.authorization);
    setCookie(creds.cookie);
    setInstanceNid(creds.instanceNid);
    setLlmInfo(loadLLMSettings());
    refreshHistory();

    // 监听localStorage变化（设置更新）
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "llm-eval-settings") {
        setLlmInfo(loadLLMSettings());
      }
    };
    window.addEventListener("storage", handleStorageChange);

    // 监听自定义事件（同页面设置更新）
    const handleSettingsUpdate = () => {
      setLlmInfo(loadLLMSettings());
    };
    window.addEventListener("llm-settings-updated", handleSettingsUpdate);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("llm-settings-updated", handleSettingsUpdate);
    };
  }, [refreshHistory]);

  // 日志自动滚到底部
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ─── 状态持久化：关键数据保存到 sessionStorage ───
  useEffect(() => {
    // 仅在非加载状态时保存，避免将中间状态写入
    if (loading) return;
    saveSessionState({
      mode,
      generatedFiles,
      generatedJobId,
      generatedOutputRoot,
      genPhase,
      generateLogs,
      reviewLogs,
      genAndReviewLogs,
      reviewResult,
      genAndReviewResult,
      selectedLevels,
      generateInputMode,
      genAndReviewInputMode,
      generateTextContent,
      genAndReviewTextContent,
    });
  }, [mode, generatedFiles, generatedJobId, generatedOutputRoot, genPhase,
    generateLogs, reviewLogs, genAndReviewLogs, reviewResult, genAndReviewResult,
    selectedLevels, generateInputMode, genAndReviewInputMode,
    generateTextContent, genAndReviewTextContent, loading]);

  const appendLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const line = `[${ts}] ${msg}`;
    // 使用 activeLogSetter ref 确保写入启动操作时的 Tab 日志
    activeLogSetterRef.current((prev) => [...prev, line]);
  }, []);

  // 追踪当前操作所属的日志 setter（在启动操作时捕获）
  const activeLogSetterRef = useRef(setLogs);

  const handleFilesSelected = (list: FileList | null) => {
    if (!list) return;
    const newFiles = Array.from(list);

    if (mode === "generate" || mode === "generate-and-review") {
      // 生成模式只允许一个文件（题卷），直接替换
      if (newFiles.length > 0) {
        setFiles([newFiles[0]]);
      }
    } else {
      setFiles((prev) => {
        const existing = new Map(prev.map((f) => [getUploadedFileKey(f), f]));
        newFiles.forEach((f) => existing.set(getUploadedFileKey(f), f));
        return Array.from(existing.values());
      });
    }

    // 重置 input value，确保下次选同一文件仍可触发 onChange
    if (inputRef.current) inputRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
  };

  const handleRemove = (file: File) => {
    const fileKey = getUploadedFileKey(file);
    setFiles((prev) => prev.filter((f) => f !== file));
    setSkipLLMFiles(prev => {
      const next = new Set(prev);
      next.delete(fileKey);
      return next;
    });
    // 从所有分组中移除
    setFileGroups(prev => {
      const next = new Map(prev);
      for (const [gid, group] of next) {
        const filtered = group.fileKeys.filter(k => k !== fileKey);
        if (filtered.length <= 1) {
          next.delete(gid); // 组只剩0-1个文件，自动解散
        } else {
          next.set(gid, { ...group, fileKeys: filtered });
        }
      }
      return next;
    });
    setSelectedForGroup(prev => { const n = new Set(prev); n.delete(fileKey); return n; });
  };

  const handleClearAll = () => {
    if (!confirm(`确定清空当前Tab「${mode === 'generate' ? '生成答案' : mode === 'review' ? '批阅评测' : '生成并评测'}」的所有数据？`)) return;

    // 清空文件
    setFiles([]);
    setSkipLLMFiles(new Set());
    setFileGroups(new Map());
    setSelectedForGroup(new Set());
    if (inputRef.current) inputRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";

    // 清空日志和结果
    setLogs([]);
    setResult(null);
    setError(null);

    // 如果是生成答案tab，还要清空生成的文件
    if (mode === "generate") {
      setGeneratedFiles([]);
      setGeneratedJobId("");
      setGeneratedOutputRoot("");
      setGenPhase("idle");
      setGenerateTextContent("");
    } else if (mode === "generate-and-review") {
      setGenAndReviewTextContent("");
    }

    // 更新sessionStorage
    const saved = loadSessionState() || {} as SessionState;
    if (mode === "generate") {
      saved.generateLogs = [];
      saved.generatedFiles = [];
      saved.generatedJobId = "";
      saved.generatedOutputRoot = "";
      saved.genPhase = "idle";
      saved.generateTextContent = "";
    } else if (mode === "review") {
      saved.reviewLogs = [];
      saved.reviewResult = null;
    } else {
      saved.genAndReviewLogs = [];
      saved.genAndReviewResult = null;
      saved.genAndReviewTextContent = "";
    }
    saveSessionState(saved);
  };

  const startReview = async () => {
    const isGenerateMode = mode === "generate" || mode === "generate-and-review";
    const usingTextInput = isGenerateMode && inputMode === "text";
    const hasPastedText = pastedText.trim().length > 0;
    // 批阅模式：支持从 generatedFiles（服务器路径）或 files（上传文件）开始
    const hasUploadedFiles = files.length > 0;
    const hasGeneratedFiles = mode === "review" && generatedFiles.length > 0;

    if (mode === "review" && !hasUploadedFiles && !hasGeneratedFiles) {
      setError("请先选择作业文件（或从「生成答案」Tab 生成后切换过来）");
      return;
    }
    if (isGenerateMode && !usingTextInput && !hasUploadedFiles) {
      setError("请上传题卷文档");
      return;
    }
    if (isGenerateMode && usingTextInput && !hasPastedText) {
      setError("请先粘贴题卷文字内容");
      return;
    }
    if (isGenerateMode && selectedLevels.length === 0) {
      setError("请至少选择一个生成等级");
      return;
    }

    // 仅生成答案模式只需 LLM Key，不需要智慧树认证
    const needsAuth = mode === "review" || mode === "generate-and-review";
    if (needsAuth && (!authorization.trim() || !cookie.trim() || !instanceNid.trim())) {
      setError("请填写完整的智慧树平台认证信息");
      return;
    }

    // 生成答案模式需要 LLM Key
    const needsLLM = isGenerateMode;
    const llm = loadLLMSettings();
    if (needsLLM && !llm.apiKey) {
      setError("请先在右上角 ⚙️ 设置中配置 LLM API Key");
      return;
    }

    // 保存凭证（如果有填写）
    if (authorization.trim() || cookie.trim() || instanceNid.trim()) {
      saveCredentials({ authorization, cookie, instanceNid });
    }

    // 锁定当前 Tab 的 log setter，即使后续用户切换了 Tab，日志仍写入正确位置
    activeLogSetterRef.current = setLogs;
    autoReviewTakenOverRef.current = false;

    setLoading(true);
    setError(null);
    setResult(null);
    setLogs([]);
    setElapsedSeconds(0);
    if (mode !== "review") {
      setGeneratedFiles([]);
      setGeneratedJobId("");
    }
    setGenPhase(mode === "generate" || mode === "generate-and-review" ? "generating" : "idle");

    // 启动计时器
    timerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    const modeLabels = { generate: "生成学生答案", review: "批阅评测", "generate-and-review": "生成并评测" };
    appendLog(`🚀 开始${modeLabels[mode]}...`);

    try {
      const formData = new FormData();

      // LLM 设置
      if (llm.apiKey) formData.append("llm_api_key", llm.apiKey);
      if (llm.apiUrl) formData.append("llm_api_url", llm.apiUrl);
      if (llm.model) {
        const mappedModel = MODEL_NAME_MAPPING[llm.model] || llm.model;
        formData.append("llm_model", mappedModel);
      }

      // 认证参数（仅需要时才传）
      if (needsAuth) {
        formData.append("authorization", authorization.trim());
        formData.append("cookie", cookie.trim());
        formData.append("instance_nid", instanceNid.trim());
      }
      formData.append("attempts", String(attempts));

      let apiUrl: string;

      if (mode === "generate" || mode === "generate-and-review") {
        // 生成答案（或生成并评测）→ 都走 generate API
        apiUrl = RAILWAY_API
          ? `${RAILWAY_API}/api/generate`
          : "/api/homework-review/generate";
        if (usingTextInput) {
          formData.append("exam_text", pastedText.trim());
          appendLog("📝 使用粘贴文字作为题卷输入");
        } else {
          formData.append("file", files[0]);
        }
        formData.append("levels", JSON.stringify(selectedLevels));
        // 传递自定义 Prompt 模板
        if (generatePromptTemplate !== DEFAULT_GENERATE_PROMPT) {
          formData.append("custom_prompt", generatePromptTemplate);
        }
        // 传递自定义等级描述
        const isCustomLevels = JSON.stringify(levelDefinitions) !== JSON.stringify(DEFAULT_LEVEL_DEFINITIONS);
        if (isCustomLevels) {
          formData.append("custom_levels", JSON.stringify(levelDefinitions));
        }
        if (mode === "generate-and-review") {
          formData.append("auto_review", "true");
        }
      } else if (hasGeneratedFiles && !hasUploadedFiles) {
        // 批阅模式 + 从生成 Tab 带过来的文件（走 server_paths）
        apiUrl = RAILWAY_API
          ? `${RAILWAY_API}/api/review`
          : "/api/homework-review";
        formData.append("server_paths", JSON.stringify(generatedFiles.map((f) => f.path)));
        formData.append("output_format", outputFormat);
        formData.append("local_parse", String(localParse));
        formData.append("max_concurrency", String(maxConcurrency));
        const skipNames = generatedFiles
          .filter(f => skipLLMFiles.has(getGeneratedFileKey(f)))
          .map(f => f.name);
        if (skipNames.length > 0) {
          formData.append("skip_llm_files", JSON.stringify(skipNames));
        }
        appendLog(`📂 使用已生成的 ${generatedFiles.length} 份答案进行批阅`);
      } else {
        // 批阅模式 + 用户上传的文件
        apiUrl = RAILWAY_API
          ? `${RAILWAY_API}/api/review`
          : "/api/homework-review";
        files.forEach((file) => formData.append("files", file));
        formData.append("output_format", outputFormat);
        formData.append("local_parse", String(localParse));
        formData.append("max_concurrency", String(maxConcurrency));
        // 传递每文件跳过LLM校验标记
        const skipNames = files.filter(f => skipLLMFiles.has(getUploadedFileKey(f))).map(f => f.name);
        if (skipNames.length > 0) {
          formData.append("skip_llm_files", JSON.stringify(skipNames));
        }
        // 传递文件分组信息
        if (fileGroups.size > 0) {
          const groupsObj: Record<string, string[]> = {};
          fileGroups.forEach((group) => {
            // 把 fileKey 转回文件名
            const fileNames = group.fileKeys.map(key => {
              const f = files.find(f => getUploadedFileKey(f) === key);
              return f?.name || key;
            }).filter(Boolean);
            if (fileNames.length > 1) {
              groupsObj[group.name] = fileNames;
            }
          });
          if (Object.keys(groupsObj).length > 0) {
            formData.append("file_groups", JSON.stringify(groupsObj));
          }
        }
      }

      // SSE 连接 + 自动重试（网络中断最多重试2次）
      const MAX_FETCH_RETRIES = 2;
      let fetchRetry = 0;
      let res: Response | null = null;
      while (fetchRetry <= MAX_FETCH_RETRIES) {
        try {
          res = await fetch(apiUrl, {
            method: "POST",
            body: formData,
          });
          break; // 成功建立连接
        } catch (fetchErr) {
          fetchRetry++;
          if (fetchRetry > MAX_FETCH_RETRIES) throw fetchErr;
          const retryDelay = fetchRetry * 3;
          appendLog(`⚠️ 网络连接失败，${retryDelay}秒后第${fetchRetry}次重试...`);
          await new Promise(r => setTimeout(r, retryDelay * 1000));
          appendLog(`🔄 正在重新连接...`);
        }
      }
      if (!res) throw new Error("无法建立连接");

      if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "操作失败");
      }

      // 读取 SSE 流（增强网络中断检测）
      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      const decoder = new TextDecoder();
      let buffer = "";
      let streamCompleted = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(part.slice(6));
              if (data.type === "log") {
                appendLog(data.message);
              } else if (data.type === "progress") {
                appendLog(data.message || `进度: ${data.current}/${data.total}`);
              } else if (data.type === "error") {
                appendLog(`❌ ${data.message}`);
                setError(data.message);
                // 出错时重置 genPhase，让用户可以重试
                if (mode !== "review") setGenPhase("idle");
              } else if (data.type === "generate_complete") {
                // ═══ 生成完成 ═══
                const newFiles = data.files || [];
                setGeneratedFiles(newFiles);
                setGeneratedJobId(data.jobId || "");
                setGeneratedOutputRoot(data.outputRoot || "");
                if (mode === "generate") {
                  // 仅生成模式：进入预览，让用户查看/下载
                  appendLog("🎉 答案生成完成！");
                  setGenPhase("preview");
                } else {
                  // 生成并评测模式：自动衔接批阅，无需用户操作
                  appendLog("🎉 答案生成完成！自动进入批阅阶段...");
                  // 标记自动衔接，防止 startReview 的 finally 清理 loading/timer
                  autoReviewTakenOverRef.current = true;
                  // 直接传入 files 避免 state 延迟
                  startReviewFromGenerated(newFiles);
                }
              } else if (data.type === "complete") {
                // ═══ 批阅完成 ═══
                appendLog("🎉 批阅全部完成！");
                const completedResult: ReviewResult = {
                  jobId: data.jobId,
                  outputFiles: data.outputFiles || [],
                  summary: data.summary || {},
                  downloadBaseUrl: data.downloadBaseUrl || "/api/homework-review/download",
                  scoreTable: data.scoreTable || null,
                };
                setResult(completedResult);

                // 自动保存评分表到历史
                const finalTable: ScoreTable | null =
                  (completedResult.scoreTable && completedResult.scoreTable.students?.length > 0)
                    ? completedResult.scoreTable
                    : buildScoreTableFromSummary(completedResult.summary);
                if (finalTable && finalTable.students.length > 0) {
                  addHistoryItem({
                    id: generateHistoryId(),
                    timestamp: new Date().toISOString(),
                    fileNames: files.map((f) => f.name),
                    attempts: finalTable.attempts,
                    jobId: data.jobId,
                    scoreTable: finalTable,
                  });
                  refreshHistory();
                  appendLog("📝 评分表已保存到历史记录");
                }
              }
            } catch { /* ignore parse errors */ }
          }
        }
        streamCompleted = true;
      } catch (streamErr) {
        // SSE 流读取中断（网络断开等）
        if (!streamCompleted) {
          const streamMsg = streamErr instanceof Error ? streamErr.message : "流读取中断";
          appendLog(`⚠️ 数据流中断: ${streamMsg}`);
          throw new Error(`网络中断: ${streamMsg}。请点击"重试"按钮继续。`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "操作失败";
      setError(msg);
      appendLog(`❌ ${msg}`);
    } finally {
      // 如果自动衔接了批阅（生成并评测），不在这里清理——由 startReviewFromGenerated 的 finally 处理
      if (autoReviewTakenOverRef.current) {
        autoReviewTakenOverRef.current = false;
      } else {
        setLoading(false);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    }
  };

  /** 从生成预览阶段 → 继续批阅（复用标准批阅 API）
   *  可以传入 filesToReview 参数（生成并评测自动化场景），避免依赖 state 延迟更新
   */
  const startReviewFromGenerated = async (filesToReview?: GeneratedAnswerFile[]) => {
    const reviewTargets = filesToReview || generatedFiles;
    if (reviewTargets.length === 0) return;
    if (!authorization.trim() || !cookie.trim() || !instanceNid.trim()) {
      setError("请填写完整的智慧树平台认证信息");
      return;
    }

    // 锁定当前 Tab 的 log setter
    activeLogSetterRef.current = setLogs;

    // 不重置 loading/timer — 如果是自动衔接，复用已有的 loading 状态
    if (!loading) {
      setLoading(true);
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    }
    setError(null);
    setResult(null);
    setGenPhase("reviewing");

    appendLog(`🚀 开始批阅 ${reviewTargets.length} 份生成答案（每份 ${attempts} 次）...`);

    try {
      const formData = new FormData();

      // 认证参数
      formData.append("authorization", authorization.trim());
      formData.append("cookie", cookie.trim());
      formData.append("instance_nid", instanceNid.trim());

      // 复用全局 LLM 设置
      const llm = loadLLMSettings();
      if (llm.apiKey) formData.append("llm_api_key", llm.apiKey);
      if (llm.apiUrl) formData.append("llm_api_url", llm.apiUrl);
      if (llm.model) {
        const mappedModel = MODEL_NAME_MAPPING[llm.model] || llm.model;
        formData.append("llm_model", mappedModel);
      }

      formData.append("attempts", String(attempts));
      formData.append("output_format", outputFormat);
      formData.append("local_parse", String(localParse));
      formData.append("max_concurrency", String(maxConcurrency));

      // 将生成的文件路径作为 server_paths 传递（避免重新上传）
      formData.append("server_paths", JSON.stringify(reviewTargets.map((f) => f.path)));
      const skipNames = reviewTargets
        .filter(f => skipLLMFiles.has(getGeneratedFileKey(f)))
        .map(f => f.name);
      if (skipNames.length > 0) {
        formData.append("skip_llm_files", JSON.stringify(skipNames));
      }

      // 直接调用Railway API绕过Vercel 300秒超时
      const reviewUrl = RAILWAY_API
        ? `${RAILWAY_API}/api/review`
        : "/api/homework-review";

      // SSE 连接 + 自动重试（网络中断最多重试2次）
      const MAX_FETCH_RETRIES = 2;
      let fetchRetry = 0;
      let res: Response | null = null;
      while (fetchRetry <= MAX_FETCH_RETRIES) {
        try {
          res = await fetch(reviewUrl, {
            method: "POST",
            body: formData,
          });
          break;
        } catch (fetchErr) {
          fetchRetry++;
          if (fetchRetry > MAX_FETCH_RETRIES) throw fetchErr;
          const retryDelay = fetchRetry * 3;
          appendLog(`⚠️ 网络连接失败，${retryDelay}秒后第${fetchRetry}次重试...`);
          await new Promise(r => setTimeout(r, retryDelay * 1000));
          appendLog(`🔄 正在重新连接...`);
        }
      }
      if (!res) throw new Error("无法建立连接");

      if (!res.ok && !res.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "批阅失败");
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      const decoder = new TextDecoder();
      let buffer = "";
      let streamCompleted = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(part.slice(6));
              if (data.type === "log") {
                appendLog(data.message);
              } else if (data.type === "error") {
                appendLog(`❌ ${data.message}`);
                setError(data.message);
              } else if (data.type === "complete") {
                appendLog("🎉 批阅全部完成！");
                const completedResult: ReviewResult = {
                  jobId: data.jobId,
                  outputFiles: data.outputFiles || [],
                  summary: data.summary || {},
                  downloadBaseUrl: data.downloadBaseUrl || "/api/homework-review/download",
                  scoreTable: data.scoreTable || null,
                };
                setResult(completedResult);
                setGenPhase("idle");

                const finalTable: ScoreTable | null =
                  (completedResult.scoreTable && completedResult.scoreTable.students?.length > 0)
                    ? completedResult.scoreTable
                    : buildScoreTableFromSummary(completedResult.summary);
                if (finalTable && finalTable.students.length > 0) {
                  addHistoryItem({
                    id: generateHistoryId(),
                    timestamp: new Date().toISOString(),
                    fileNames: reviewTargets.map((f) => f.name),
                    attempts: finalTable.attempts,
                    jobId: data.jobId,
                    scoreTable: finalTable,
                  });
                  refreshHistory();
                  appendLog("📝 评分表已保存到历史记录");
                }
              }
            } catch { /* ignore */ }
          }
        }
        streamCompleted = true;
      } catch (streamErr) {
        if (!streamCompleted) {
          const streamMsg = streamErr instanceof Error ? streamErr.message : "流读取中断";
          appendLog(`⚠️ 数据流中断: ${streamMsg}`);
          throw new Error(`网络中断: ${streamMsg}。请点击"重试"按钮继续。`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "批阅失败";
      setError(msg);
      appendLog(`❌ ${msg}`);
    } finally {
      setLoading(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  /** 预览生成的 docx 文件（调用预览接口转为 HTML） */
  const previewDocx = async (file: { name: string; path: string }) => {
    if (previewingFile === file.name) {
      // 点击已展开的文件 → 折叠
      setPreviewingFile(null);
      setPreviewHtml("");
      return;
    }
    setPreviewingFile(file.name);
    setPreviewLoading(true);
    setPreviewHtml("");
    try {
      // Railway 上的文件走 Railway 预览接口，本地文件走 Vercel
      const previewUrl = RAILWAY_API && file.path.startsWith("/tmp/")
        ? `${RAILWAY_API}/api/preview?path=${encodeURIComponent(file.path)}`
        : `/api/homework-review/preview?path=${encodeURIComponent(file.path)}`;
      const res = await fetch(previewUrl);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "预览失败");
      setPreviewHtml(data.html || "<p>文档内容为空</p>");
    } catch (e) {
      setPreviewHtml(`<p style="color:red">预览失败: ${e instanceof Error ? e.message : "未知错误"}</p>`);
    } finally {
      setPreviewLoading(false);
    }
  };

  /** 下载生成的 docx 文件 */
  const downloadGeneratedFile = (file: { name: string; path: string }) => {
    // Railway 上的文件走 Railway 下载接口
    const url = RAILWAY_API && file.path.startsWith("/tmp/")
      ? `${RAILWAY_API}/api/files?path=${encodeURIComponent(file.path)}`
      : `/api/homework-review/preview?path=${encodeURIComponent(file.path)}&download=1`;
    window.open(url, "_blank");
  };

  const downloadLink = (file: string) => {
    if (!result) return "#";
    // Railway 模式：outputFiles 是 /tmp/xxx 绝对路径，走 Railway /api/files 下载
    if (RAILWAY_API && file.startsWith("/tmp/")) {
      return `${RAILWAY_API}/api/files?path=${encodeURIComponent(file)}`;
    }
    // 本地模式：走 Vercel 的 download endpoint
    const url = new URL(result.downloadBaseUrl, window.location.origin);
    url.searchParams.set("jobId", result.jobId);
    url.searchParams.set("file", file);
    return url.toString();
  };

  /** 从绝对路径提取「上级目录/文件名」用于显示，方便区分不同等级 */
  const displayName = (file: string) => {
    const parts = file.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
    return parts[parts.length - 1] || file;
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}分${sec.toString().padStart(2, "0")}秒` : `${sec}秒`;
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-6">
      {/* ─── 历史记录入口 ─── */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">作业批阅</h1>
        <button
          onClick={() => { setShowHistory(!showHistory); setViewingHistory(null); }}
          className={clsx(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition",
            showHistory
              ? "bg-indigo-100 text-indigo-700"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          )}
        >
          <Clock className="w-4 h-4" />
          历史记录
          {historyList.length > 0 && (
            <span className="text-xs bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-full">
              {historyList.length}
            </span>
          )}
        </button>
      </div>

      {/* ─── 查看历史评分表 ─── */}
      {viewingHistory && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setViewingHistory(null)}
              className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
            >
              ← 返回
            </button>
            <span className="text-sm text-slate-500">
              {new Date(viewingHistory.timestamp).toLocaleString("zh-CN")}  ·  {viewingHistory.fileNames.join(", ")}
            </span>
          </div>
          <ScoreTableView scoreTable={viewingHistory.scoreTable} />
        </div>
      )}

      {/* ─── 历史记录列表 ─── */}
      {showHistory && !viewingHistory && (
        <ReviewHistoryPanel
          history={historyList}
          onView={(item) => setViewingHistory(item)}
          onDelete={(id) => { deleteHistoryItem(id); refreshHistory(); }}
        />
      )}

      {/* ─── 智慧树认证配置（仅批阅评测和生成并评测需要）─── */}
      {(mode === "review" || mode === "generate-and-review") && (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-2xl bg-amber-50 flex items-center justify-center">
              <Key className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">智慧树平台认证</h2>
              <p className="text-xs text-slate-500">从浏览器开发者工具获取认证信息，本地保存不上传</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Authorization</label>
              <input
                type="password"
                value={authorization}
                onChange={(e) => setAuthorization(e.target.value)}
                placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9..."
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Cookie</label>
              <input
                type="password"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                placeholder="hike-polymas-identity=1; themeVariables=..."
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Instance NID</label>
              <input
                type="text"
                value={instanceNid}
                onChange={(e) => setInstanceNid(e.target.value)}
                placeholder="XLRNIzbkox"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            {/* LLM 信息提示 */}
            <div className="flex items-start gap-2 bg-indigo-50 text-indigo-700 text-xs rounded-lg px-3 py-2">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                LLM 配置自动复用全局设置（右上角 ⚙️ 设置），当前模型：
                <strong>{llmInfo.model || "未配置"}</strong>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ─── 文件上传 & 参数配置 ─── */}
      <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center">
              <Upload className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">
                {mode === "generate" ? "生成学生答案" : mode === "review" ? "上传作业文件" : "生成并评测"}
              </h2>
              <p className="text-xs text-slate-500">
                {mode === "generate"
                  ? "上传空白题卷或直接粘贴文字，使用 LLM 生成多等级学生答案（无需智慧树认证）"
                  : mode === "review"
                    ? "上传学生作业文档，自动解析并批阅"
                    : "上传空白题卷或直接粘贴文字，自动生成多等级答案并评测"}
              </p>
            </div>
          </div>

          <div className="bg-slate-100 p-1 rounded-lg flex items-center">
            <button
              onClick={() => setMode("generate")}
              className={clsx(
                "px-3 py-1.5 text-sm font-medium rounded-md transition",
                mode === "generate" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
              )}
            >
              生成答案
            </button>
            <button
              onClick={() => setMode("review")}
              className={clsx(
                "px-3 py-1.5 text-sm font-medium rounded-md transition",
                mode === "review" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
              )}
            >
              批阅评测
            </button>
            <button
              onClick={() => setMode("generate-and-review")}
              className={clsx(
                "px-3 py-1.5 text-sm font-medium rounded-md transition",
                mode === "generate-and-review" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
              )}
            >
              生成并评测
            </button>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* 左侧：文件上传 */}
          <div>
            {mode !== "review" && (
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-medium text-slate-700">题卷输入方式</div>
                <div className="bg-slate-100 p-1 rounded-lg flex items-center">
                  <button
                    type="button"
                    onClick={() => setInputMode?.("file")}
                    className={clsx(
                      "px-3 py-1.5 text-sm font-medium rounded-md transition flex items-center gap-1.5",
                      inputMode === "file" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    <Upload className="w-4 h-4" />
                    文件
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode?.("text")}
                    className={clsx(
                      "px-3 py-1.5 text-sm font-medium rounded-md transition flex items-center gap-1.5",
                      inputMode === "text" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    )}
                  >
                    <Type className="w-4 h-4" />
                    粘贴文字
                  </button>
                </div>
              </div>
            )}
            <div
              className={clsx(
                "border-2 border-dashed rounded-2xl p-6 transition",
                mode !== "review" && inputMode === "text"
                  ? (pastedText.trim() ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white")
                  : (files.length > 0 ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white")
              )}
            >
              <input
                key={`file-${mode}`}
                ref={inputRef}
                type="file"
                multiple={mode === "review"}
                accept={mode === "review" ? ".doc,.docx,.pdf,.ppt,.pptx,.png,.jpg,.jpeg" : ".doc,.docx,.pdf"}
                className="hidden"
                onChange={(e) => handleFilesSelected(e.target.files)}
              />
              <input
                key={`folder-${mode}`}
                // @ts-ignore
                webkitdirectory="true"
                ref={folderRef}
                type="file"
                multiple={mode === "review"}
                className="hidden"
                onChange={(e) => handleFilesSelected(e.target.files)}
              />
              {mode !== "review" && inputMode === "text" ? (
                <div className="space-y-4">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center">
                      <Type className="w-6 h-6 text-indigo-600" />
                    </div>
                    <div className="text-sm text-slate-600">
                      直接复制题卷文字到下方，系统会自动生成学生答案
                    </div>
                  </div>
                  <textarea
                    value={pastedText}
                    onChange={(e) => setPastedText?.(e.target.value)}
                    rows={12}
                    placeholder="将题卷全文粘贴到这里，建议保留题号、题型、作答要求等完整内容..."
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300 resize-y"
                  />
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>支持直接从 Word / PDF 中复制文本后粘贴使用</span>
                    <span>{pastedText.trim() ? `${pastedText.trim().length} 字` : "未粘贴内容"}</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center">
                    <Upload className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div className="text-sm text-slate-600">
                    {mode === "review"
                      ? "支持 doc/docx/pdf/ppt/pptx/png/jpg，支持多文件或文件夹"
                      : "支持 doc/docx/pdf 格式的题卷文件，也支持切换到“粘贴文字”直接生成"
                    }
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="px-3 py-2 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                      onClick={() => inputRef.current?.click()}
                    >
                      选择文件
                    </button>
                    <button
                      type="button"
                      className="px-3 py-2 text-sm font-semibold bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                      onClick={() => folderRef.current?.click()}
                    >
                      选择文件夹
                    </button>
                  </div>
                </div>
              )}
            </div>

            {(mode === "review" || inputMode === "file") && files.length > 0 && (() => {
              // 构建分组视图数据
              const groupedKeys = new Set<string>();
              fileGroups.forEach(g => g.fileKeys.forEach(k => groupedKeys.add(k)));
              const ungroupedFiles = files.filter(f => !groupedKeys.has(getUploadedFileKey(f)));

              const renderFileRow = (file: File, inGroup = false) => {
                const fileKey = getUploadedFileKey(file);
                const isSkipped = skipLLMFiles.has(fileKey);
                const isSelected = selectedForGroup.has(fileKey);
                return (
                  <div
                    key={fileKey}
                    className={clsx(
                      "flex items-center justify-between rounded-lg px-3 py-2",
                      inGroup ? "bg-white" : "bg-slate-50",
                      isSelected && !inGroup && "ring-2 ring-indigo-300 bg-indigo-50"
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {!inGroup && mode === "review" && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            setSelectedForGroup(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(fileKey);
                              else next.delete(fileKey);
                              return next;
                            });
                          }}
                          className="w-3.5 h-3.5 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300 flex-shrink-0"
                          title="选中后可合并为一组"
                        />
                      )}
                      <div className="text-sm text-slate-700 truncate">{file.name}</div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      {mode === "review" && (
                        <label className="flex items-center gap-1 cursor-pointer select-none" title="跳过 LLM 校验">
                          <input
                            type="checkbox"
                            checked={isSkipped}
                            onChange={(e) => {
                              setSkipLLMFiles(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(fileKey);
                                else next.delete(fileKey);
                                return next;
                              });
                            }}
                            className="w-3.5 h-3.5 rounded text-amber-600 focus:ring-amber-500 border-slate-300"
                          />
                          <span className={clsx("text-[10px] font-medium", isSkipped ? "text-amber-700" : "text-slate-400")}>跳过校验</span>
                        </label>
                      )}
                      <button
                        className="text-slate-400 hover:text-red-500"
                        onClick={() => handleRemove(file)}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              };

              return (
                <div className="mt-4 space-y-2 max-h-72 overflow-auto">
                  {/* 已分组的文件 */}
                  {Array.from(fileGroups.entries()).map(([gid, group]) => {
                    const groupFiles = group.fileKeys
                      .map(k => files.find(f => getUploadedFileKey(f) === k))
                      .filter(Boolean) as File[];
                    if (groupFiles.length === 0) return null;
                    return (
                      <div key={gid} className="border-2 border-indigo-200 rounded-xl bg-indigo-50/50 p-2 space-y-1">
                        <div className="flex items-center justify-between px-1 mb-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-indigo-700">📁 {group.name}</span>
                            <span className="text-[10px] text-indigo-500">({groupFiles.length}个文件合并批阅)</span>
                          </div>
                          <button
                            className="text-[10px] text-indigo-500 hover:text-red-500 px-1.5 py-0.5 rounded hover:bg-white"
                            onClick={() => {
                              setFileGroups(prev => {
                                const next = new Map(prev);
                                next.delete(gid);
                                return next;
                              });
                            }}
                          >
                            拆分
                          </button>
                        </div>
                        {groupFiles.map(f => renderFileRow(f, true))}
                      </div>
                    );
                  })}

                  {/* 未分组的文件 */}
                  {ungroupedFiles.map(f => renderFileRow(f, false))}

                  {/* 合并按钮 + 清空 */}
                  <div className="flex items-center gap-3">
                    {mode === "review" && selectedForGroup.size >= 2 && (
                      <button
                        className="text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg px-3 py-1.5"
                        onClick={() => {
                          const name = prompt("请输入组名（如：学生A的作业）");
                          if (!name) return;
                          const gid = Date.now().toString();
                          setFileGroups(prev => {
                            const next = new Map(prev);
                            next.set(gid, { name, fileKeys: Array.from(selectedForGroup) });
                            return next;
                          });
                          setSelectedForGroup(new Set());
                        }}
                      >
                        合并为一组 ({selectedForGroup.size})
                      </button>
                    )}
                    <button
                      className="text-xs text-slate-500 hover:text-red-600"
                      onClick={handleClearAll}
                    >
                      清空全部
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* 批阅模式下：显示从「生成答案」Tab 带过来的文件 */}
            {mode === "review" && generatedFiles.length > 0 && files.length === 0 && (
              <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm font-semibold text-emerald-800">
                    已加载 {generatedFiles.length} 份生成答案
                  </span>
                </div>
                <div className="space-y-1.5 mb-3 max-h-40 overflow-auto">
                  {generatedFiles.map((f, i) => {
                    const fileKey = getGeneratedFileKey(f);
                    const isSkipped = skipLLMFiles.has(fileKey);
                    return (
                      <div key={fileKey} className="flex items-center justify-between gap-2 text-xs text-emerald-700 bg-white rounded px-3 py-1.5">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                          <span className="truncate">{f.name}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <label className="flex items-center gap-1 cursor-pointer select-none" title="跳过 LLM 校验">
                            <input
                              type="checkbox"
                              checked={isSkipped}
                              onChange={(e) => {
                                setSkipLLMFiles(prev => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(fileKey);
                                  else next.delete(fileKey);
                                  return next;
                                });
                              }}
                              className="w-3.5 h-3.5 rounded text-amber-600 focus:ring-amber-500 border-slate-300"
                            />
                            <span className={clsx("text-[10px] font-medium", isSkipped ? "text-amber-700" : "text-slate-400")}>跳过校验</span>
                          </label>
                          <button
                            onClick={() => {
                              setGeneratedFiles(prev => prev.filter((_, idx) => idx !== i));
                              setSkipLLMFiles(prev => {
                                const next = new Set(prev);
                                next.delete(fileKey);
                                return next;
                              });
                            }}
                            className="text-slate-400 hover:text-red-500"
                            title="删除此答案"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-emerald-600">
                  这些文件来自「生成答案」Tab，点击下方"开始批阅"即可直接批阅
                </p>
              </div>
            )}
          </div>

          {/* 右侧：参数配置 */}
          <div className="space-y-4">
            {(mode === "generate" || mode === "generate-and-review") && (
              <>
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                  <label className="block text-sm font-medium text-slate-700 mb-2">生成等级选择</label>
                  <div className="grid grid-cols-1 gap-2">
                    {LEVEL_OPTIONS.map((lvl) => (
                      <label key={lvl} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer hover:text-slate-900 transition">
                        <input
                          type="checkbox"
                          checked={selectedLevels.includes(lvl)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLevels((p) => [...p, lvl]);
                            else setSelectedLevels((p) => p.filter((x) => x !== lvl));
                          }}
                          className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
                        />
                        <span>{lvl}</span>
                      </label>
                    ))}
                  </div>

                  {/* 等级描述编辑器 */}
                  <div className="mt-3 pt-3 border-t border-slate-200">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-600 transition"
                      onClick={() => setShowLevelEditor(!showLevelEditor)}
                    >
                      {showLevelEditor ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {showLevelEditor ? "收起等级描述" : "自定义等级描述"}
                    </button>
                    {showLevelEditor && (
                      <div className="mt-2 space-y-2">
                        <p className="text-[10px] text-slate-400">自定义各等级的能力描述（将替换 Prompt 中的 <code className="bg-slate-200 px-1 rounded">{`{{level_desc}}`}</code>），可根据作业满分调整分数范围。</p>
                        {LEVEL_OPTIONS.map((lvl) => (
                          <div key={lvl} className="flex items-start gap-2">
                            <label className="text-[10px] text-slate-500 w-16 pt-1.5 flex-shrink-0 truncate" title={lvl}>
                              {lvl.replace("的回答", "")}
                            </label>
                            <input
                              type="text"
                              value={levelDefinitions[lvl] || ""}
                              onChange={(e) => setLevelDefinitions(prev => ({ ...prev, [lvl]: e.target.value }))}
                              className="flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-700 focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                              placeholder="描述该等级的表现特征..."
                            />
                          </div>
                        ))}
                        {JSON.stringify(levelDefinitions) !== JSON.stringify(DEFAULT_LEVEL_DEFINITIONS) && (
                          <button
                            type="button"
                            className="text-[10px] text-indigo-500 hover:text-indigo-700"
                            onClick={() => setLevelDefinitions({ ...DEFAULT_LEVEL_DEFINITIONS })}
                          >
                            恢复默认描述
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 生成 Prompt 编辑器 */}
                <div className="mt-2">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-600 transition"
                    onClick={() => setShowPromptEditor(!showPromptEditor)}
                  >
                    {showPromptEditor ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {showPromptEditor ? "收起 Prompt 模板" : "编辑 Prompt 模板"}
                  </button>
                  {showPromptEditor && (
                    <div className="mt-2 space-y-2">
                      <div className="text-[10px] text-slate-400 leading-relaxed">
                        可用变量：<code className="bg-slate-200 px-1 rounded">{`{{title}}`}</code> 试卷标题、
                        <code className="bg-slate-200 px-1 rounded">{`{{level}}`}</code> 等级名、
                        <code className="bg-slate-200 px-1 rounded">{`{{level_desc}}`}</code> 等级描述、
                        <code className="bg-slate-200 px-1 rounded">{`{{exam_content}}`}</code> 试卷内容
                      </div>
                      <textarea
                        value={generatePromptTemplate}
                        onChange={(e) => setGeneratePromptTemplate(e.target.value)}
                        rows={10}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono text-slate-700 focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                      />
                      {generatePromptTemplate !== DEFAULT_GENERATE_PROMPT && (
                        <button
                          type="button"
                          className="text-[10px] text-indigo-500 hover:text-indigo-700"
                          onClick={() => setGeneratePromptTemplate(DEFAULT_GENERATE_PROMPT)}
                        >
                          恢复默认 Prompt
                        </button>
                      )}
                    </div>
                  )}
                </div>
                </>
            )}

                {/* LLM 配置提示（生成模式显示） */}
                {(mode === "generate" || mode === "generate-and-review") && (
                  <div className="flex items-start gap-2 bg-indigo-50 text-indigo-700 text-xs rounded-lg px-3 py-2">
                    <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>
                      LLM 配置自动复用全局设置（右上角 ⚙️），当前模型：
                      <strong>{llmInfo.model || "未配置"}</strong>
                      {!llmInfo.apiKey && <span className="text-red-500 ml-1">（⚠️ 未设置 API Key）</span>}
                    </span>
                  </div>
                )}

                {/* 评测次数（批阅时才需要） */}
                {(mode === "review" || mode === "generate-and-review") && (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">评测次数</label>
                    <input
                      type="number"
                      min={1}
                      value={attempts}
                      onChange={(e) => setAttempts(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    />
                  </div>
                )}

                {/* 输出格式（批阅时才需要） */}
                {(mode === "review" || mode === "generate-and-review") && (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">输出格式</label>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value as "json" | "pdf")}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                    >
                      <option value="json">JSON</option>
                    </select>
                  </div>
                )}

                {/* 高级设置折叠（批阅时才需要） */}
                {(mode === "review" || mode === "generate-and-review") && (
                  <>
                    <button
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-indigo-600"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                      高级设置
                      {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>

                    {showAdvanced && (
                      <div className="space-y-3 pl-2 border-l-2 border-slate-100">
                        <div className="flex items-center gap-2">
                          <input
                            id="localParse"
                            type="checkbox"
                            checked={localParse}
                            onChange={(e) => setLocalParse(e.target.checked)}
                          />
                          <label htmlFor="localParse" className="text-sm text-slate-700">
                            使用本地解析（跳过云端 OCR）
                          </label>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1">最大并发数</label>
                          <input
                            type="number"
                            min={1}
                            value={maxConcurrency}
                            onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {error && (
                  <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button
                      onClick={() => { setError(null); startReview(); }}
                      disabled={loading}
                      className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 rounded-md transition disabled:opacity-50"
                      title="重试"
                    >
                      <RefreshCw className="w-3 h-3" />
                      重试
                    </button>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleClearAll}
                    disabled={loading}
                    className="flex-shrink-0 px-4 py-2.5 rounded-lg text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    title="清空当前Tab所有数据"
                  >
                    <X className="w-4 h-4" />
                  </button>
                  <button
                    onClick={startReview}
                    disabled={loading}
                    className={clsx(
                      "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition",
                      loading
                        ? "bg-slate-200 text-slate-500 cursor-not-allowed"
                        : "bg-indigo-600 text-white hover:bg-indigo-700"
                    )}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {genPhase === "generating" ? "生成中" : genPhase === "reviewing" ? "批阅中" : "处理中"} ({formatTime(elapsedSeconds)})
                      </>
                    ) : mode === "generate" ? (
                      "生成学生答案"
                    ) : mode === "generate-and-review" ? (
                      "生成并评测"
                    ) : (
                      "开始批阅"
                    )}
                  </button>
                </div>
              </div>
          </div>
        </div>

        {/* ─── 生成预览面板（只要有 generatedFiles 且在生成 Tab 就显示） ─── */}
        {mode === "generate" && generatedFiles.length > 0 && !loading && (
          <div className="bg-white rounded-3xl shadow-sm border border-emerald-200 p-8">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">答案生成完成</h2>
                <p className="text-xs text-slate-500">
                  已生成 {generatedFiles.length} 份不同等级的学生答案，点击文件名可预览内容
                </p>
              </div>
            </div>

            {/* 文件列表（可点击预览） */}
            <div className="space-y-2 mb-6">
              {generatedFiles.map((f, i) => (
                <div key={i}>
                  <div
                    className={clsx(
                      "flex items-center gap-3 rounded-lg px-4 py-2.5 cursor-pointer transition",
                      previewingFile === f.name
                        ? "bg-indigo-50 border border-indigo-200"
                        : "bg-emerald-50 hover:bg-emerald-100"
                    )}
                    onClick={() => previewDocx(f)}
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    <span className="text-sm text-slate-700 font-medium flex-1">{f.name}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadGeneratedFile(f); }}
                        className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-slate-700 transition"
                        title="下载文件"
                      >
                        <FileDown className="w-4 h-4" />
                      </button>
                      <Eye className={clsx("w-4 h-4 transition", previewingFile === f.name ? "text-indigo-600" : "text-slate-400")} />
                    </div>
                  </div>

                  {/* 内联预览 */}
                  {previewingFile === f.name && (
                    <div className="mt-2 ml-7 border border-slate-200 rounded-xl overflow-hidden">
                      {previewLoading ? (
                        <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          正在加载预览...
                        </div>
                      ) : (
                        <div className="max-h-96 overflow-auto">
                          <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200">
                            <span className="text-xs font-medium text-slate-600">📄 {f.name}</span>
                            <button
                              onClick={() => { setPreviewingFile(null); setPreviewHtml(""); }}
                              className="text-xs text-slate-500 hover:text-red-500"
                            >
                              关闭预览
                            </button>
                          </div>
                          <div
                            className="prose prose-sm prose-slate max-w-none p-4"
                            dangerouslySetInnerHTML={{ __html: previewHtml }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setMode("review")}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition"
              >
                切换到「批阅评测」Tab 批阅这些答案
              </button>

              <button
                onClick={handleClearAll}
                disabled={loading}
                className="px-4 py-3 rounded-xl text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition"
              >
                重新生成
              </button>
            </div>
          </div>
        )}

        {/* ─── 实时日志面板 ─── */}
        {logs.length > 0 && (
          <div className="bg-slate-900 rounded-3xl shadow-sm border border-slate-700 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-3 bg-slate-800 border-b border-slate-700">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-semibold text-slate-200">批阅日志</span>
                {loading && (
                  <span className="flex items-center gap-1 text-xs text-amber-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    进行中 ({formatTime(elapsedSeconds)})
                  </span>
                )}
              </div>
              <span className="text-xs text-slate-500">{logs.length} 条</span>
            </div>
            <div className="px-5 py-4 max-h-80 overflow-y-auto font-mono text-xs leading-relaxed space-y-0.5">
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={clsx(
                    "whitespace-pre-wrap break-all",
                    line.includes("❌") ? "text-red-400" :
                      line.includes("⚠️") ? "text-amber-400" :
                        line.includes("✅") || line.includes("🎉") ? "text-emerald-400" :
                          line.includes("⏳") || line.includes("🔄") ? "text-sky-400" :
                            "text-slate-300"
                  )}
                >
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {/* ─── 批阅结果 ─── */}
        {result && (() => {
          // 优先用 Python 提供的 scoreTable，否则从 summary.results 回溯构建
          const scoreTable: ScoreTable | null =
            (result.scoreTable && result.scoreTable.students?.length > 0)
              ? result.scoreTable
              : buildScoreTableFromSummary(result.summary);

          return (
            <div className="space-y-6">
              {/* 评分表可视化 */}
              {scoreTable && scoreTable.students.length > 0 && (
                <ScoreTableView scoreTable={scoreTable} />
              )}

              {/* 输出文件下载 */}
              <OutputFilesSection result={result} downloadLink={downloadLink} />
            </div>
          );
        })()}
      </div>
      );
}

      /* ─────────────────────────────────────────────────────────────────────
         评分表可视化组件
         ─────────────────────────────────────────────────────────────────── */

      function ScoreTableView({scoreTable}: {scoreTable: ScoreTable }) {
  const {attempts, students} = scoreTable;
      const attemptCols = Array.from({length: attempts }, (_, i) => `第${i + 1}次`);
      const [showDetailed, setShowDetailed] = React.useState(false);

      // 检查是否有逐题评分数据
      const hasQuestionData = students.some((s) => s.questions && s.questions.length > 0);

      return (
      <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-50 flex items-center justify-center">
              <Table2 className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">评分表</h2>
              <p className="text-xs text-slate-500">
                共 {students.length} 份作业，每份评测 {attempts} 次
              </p>
            </div>
          </div>
          {hasQuestionData && (
            <label className="flex items-center gap-2 cursor-pointer select-none group">
              <input
                type="checkbox"
                checked={showDetailed}
                onChange={(e) => setShowDetailed(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
              <span className="text-sm text-slate-600 group-hover:text-slate-900 transition-colors">
                展示逐题评分明细
              </span>
            </label>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-600">
                <th className="px-4 py-3 text-left font-semibold border-b border-slate-200 min-w-[180px] sticky left-0 bg-slate-50 z-10">
                  档次 / 学生
                </th>
                <th className="px-4 py-3 text-left font-semibold border-b border-slate-200 min-w-[120px]">
                  评价维度
                </th>
                {attemptCols.map((col) => (
                  <th key={col} className="px-3 py-3 text-center font-semibold border-b border-slate-200 min-w-[64px]">
                    {col}
                  </th>
                ))}
                <th className="px-3 py-3 text-center font-semibold border-b border-slate-200 min-w-[64px] text-indigo-600">
                  均值
                </th>
                <th className="px-3 py-3 text-center font-semibold border-b border-slate-200 min-w-[64px] text-amber-600">
                  方差
                </th>
              </tr>
            </thead>
            <tbody>
              {students.map((student, si) => {
                const catRows = student.categories.length;
                const dimRows = student.dimensions.length;
                const questionRows = showDetailed ? (student.questions?.length ?? 0) : 0;
                // 总分行 + 题型合并行 + 逐题明细行 + 维度行
                const totalRowCount = 1 + catRows + questionRows + dimRows;

                const rows: React.ReactNode[] = [];

                // 第一行：总分
                rows.push(
                  <tr
                    key={`${si}-total`}
                    className={clsx(
                      "border-b border-slate-100",
                      si % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                    )}
                  >
                    <td
                      rowSpan={totalRowCount}
                      className={clsx(
                        "px-4 py-2.5 font-medium text-slate-800 align-top border-r border-slate-100 sticky left-0 z-10",
                        si % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                      )}
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold">{student.name}</span>
                        <span className="text-xs text-slate-400 mt-0.5">满分 {student.full_mark}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-indigo-700 bg-indigo-50/50">
                      总分
                    </td>
                    {student.total_scores.map((s, j) => (
                      <td key={j} className="px-3 py-2.5 text-center font-medium bg-indigo-50/50">
                        <ScoreCell value={s} fullMark={student.full_mark} />
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-center font-bold text-indigo-700 bg-indigo-50/50">
                      {student.mean ?? "—"}
                    </td>
                    <td className={clsx(
                      "px-3 py-2.5 text-center font-medium",
                      student.variance != null && student.variance > 5
                        ? "bg-red-100 text-red-600 font-bold"
                        : "text-amber-600 bg-indigo-50/50"
                    )}>
                      {student.variance != null && student.variance > 5 && (
                        <span title="方差过大，评分一致性较差" className="mr-0.5">⚠️</span>
                      )}
                      {student.variance ?? "—"}
                    </td>
                  </tr>
                );

                // 题型分行（合并总分）
                student.categories.forEach((cat, ci) => {
                  rows.push(
                    <tr
                      key={`${si}-cat-${ci}`}
                      className={clsx(
                        "border-b border-slate-50",
                        si % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                      )}
                    >
                      <td className="px-4 py-2 text-slate-600">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 mr-1">题型</span>
                        {cat.name}
                        {cat.total != null && (
                          <span className="text-xs text-slate-400 ml-1">({cat.total}分)</span>
                        )}
                      </td>
                      {cat.scores.map((s, j) => (
                        <td key={j} className="px-3 py-2 text-center text-slate-600">
                          {s ?? "—"}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-center font-medium text-indigo-600">
                        {cat.mean ?? "—"}
                      </td>
                      <td className={clsx(
                        "px-3 py-2 text-center",
                        cat.variance != null && cat.variance > 5
                          ? "bg-red-100 text-red-600 font-bold"
                          : "text-amber-600"
                      )}>
                        {cat.variance != null && cat.variance > 5 && (
                          <span title="方差过大" className="mr-0.5">⚠️</span>
                        )}
                        {cat.variance ?? "—"}
                      </td>
                    </tr>
                  );
                });

                // 逐题明细行（仅在勾选时显示）
                if (showDetailed && student.questions) {
                  student.questions.forEach((q, qi) => {
                    rows.push(
                      <tr
                        key={`${si}-q-${qi}`}
                        className={clsx(
                          "border-b border-slate-50",
                          si % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                        )}
                      >
                        <td className="px-4 py-1.5 text-slate-500 text-xs">
                          <span className="inline-block px-1.5 py-0.5 rounded bg-teal-50 text-teal-600 mr-1">小题</span>
                          {q.name}
                          {q.total != null && (
                            <span className="text-slate-400 ml-1">({q.total}分)</span>
                          )}
                        </td>
                        {q.scores.map((s, j) => (
                          <td key={j} className="px-3 py-1.5 text-center text-slate-500 text-xs">
                            {s ?? "—"}
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-center font-medium text-teal-600 text-xs">
                          {q.mean ?? "—"}
                        </td>
                        <td className={clsx(
                          "px-3 py-1.5 text-center text-xs",
                          q.variance != null && q.variance > 2
                            ? "bg-red-50 text-red-500 font-bold"
                            : "text-amber-500"
                        )}>
                          {q.variance != null && q.variance > 2 && (
                            <span title="方差较大" className="mr-0.5">⚠️</span>
                          )}
                          {q.variance ?? "—"}
                        </td>
                      </tr>
                    );
                  });
                }

                // 评价维度行
                student.dimensions.forEach((dim, di) => {
                  rows.push(
                    <tr
                      key={`${si}-dim-${di}`}
                      className={clsx(
                        "border-b border-slate-50",
                        si % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                      )}
                    >
                      <td className="px-4 py-2 text-slate-600">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 mr-1">维度</span>
                        {dim.name}
                      </td>
                      {dim.scores.map((s, j) => (
                        <td key={j} className="px-3 py-2 text-center text-slate-600">
                          {s ?? "—"}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-center font-medium text-indigo-600">
                        {dim.mean ?? "—"}
                      </td>
                      <td className={clsx(
                        "px-3 py-2 text-center",
                        dim.variance != null && dim.variance > 5
                          ? "bg-red-100 text-red-600 font-bold"
                          : "text-amber-600"
                      )}>
                        {dim.variance != null && dim.variance > 5 && (
                          <span title="方差过大" className="mr-0.5">⚠️</span>
                        )}
                        {dim.variance ?? "—"}
                      </td>
                    </tr>
                  );
                });

                // 学生分隔线
                rows.push(
                  <tr key={`${si}-sep`} className="h-0.5 bg-slate-200">
                    <td colSpan={attempts + 4} />
                  </tr>
                );

                return rows;
              })}
            </tbody>
          </table>
        </div>
      </div>
      );
}

      /* 分数单元格，低分标红高分标绿 */
      function ScoreCell({value, fullMark}: {value: number | null; fullMark: number }) {
  if (value == null) return <span className="text-slate-300">—</span>;
  const ratio = fullMark > 0 ? value / fullMark : 0;
      return (
      <span
        className={clsx(
          "font-medium",
          ratio >= 0.85 ? "text-emerald-600" :
            ratio >= 0.6 ? "text-slate-700" :
              "text-red-500"
        )}
      >
        {value}
      </span>
      );
}

      /* ─────────────────────────────────────────────────────────────────────
         输出文件区（JSON 折叠，xlsx/pdf 突出显示）
         ─────────────────────────────────────────────────────────────────── */

      function OutputFilesSection({
        result,
        downloadLink,
}: {
        result: ReviewResult;
  downloadLink: (file: string) => string;
}) {
  const [showAllFiles, setShowAllFiles] = useState(false);
      const [previewingJson, setPreviewingJson] = useState<string | null>(null);
      const [jsonContent, setJsonContent] = useState<any>(null);
        const [jsonLoading, setJsonLoading] = useState(false);

  /** 从绝对路径提取「上级目录/文件名」用于显示，方便区分不同等级 */
  const displayName = (file: string) => {
    const parts = file.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
        return parts[parts.length - 1] || file;
  };

  /** 预览JSON文件 */
  const previewJson = async (file: string) => {
    if (previewingJson === file) {
          setPreviewingJson(null);
        setJsonContent(null);
        return;
    }
        setPreviewingJson(file);
        setJsonLoading(true);
        setJsonContent(null);
        try {
      const response = await fetch(downloadLink(file));
        if (!response.ok) throw new Error("Failed to fetch JSON");
        const data = await response.json();
        setJsonContent(data);
    } catch (error) {
          setJsonContent({ error: "无法加载JSON文件" });
    } finally {
          setJsonLoading(false);
    }
  };

        // 将文件分为 "重要" 和 "其他"
        const importantExts = [".xlsx", ".pdf", ".csv"];
  const importantFiles = result.outputFiles.filter((f) =>
    importantExts.some((ext) => f.toLowerCase().endsWith(ext))
        );
        const otherFiles = result.outputFiles.filter(
    (f) => !importantExts.some((ext) => f.toLowerCase().endsWith(ext))
        );

        return (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8">
          <div className="flex items-center gap-2 text-emerald-600 mb-3">
            <CheckCircle2 className="w-5 h-5" />
            <span className="font-semibold text-lg">批阅完成</span>
          </div>
          <div className="text-sm text-slate-500 mb-4">
            Job ID: <span className="font-mono">{result.jobId}</span>
            {result.summary?.success_count !== undefined && (
              <span className="ml-3">
                成功 <strong className="text-emerald-600">{result.summary.success_count}</strong> 次
              </span>
            )}
          </div>

          {/* 重要文件（xlsx 等） */}
          {importantFiles.length > 0 && (
            <div className="space-y-2 mb-4">
              {importantFiles.map((file) => (
                <a
                  key={file}
                  href={downloadLink(file)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between bg-indigo-50 rounded-lg px-4 py-3 text-sm text-indigo-700 font-medium hover:bg-indigo-100 transition border border-indigo-100"
                >
                  <span className="truncate flex items-center gap-2">
                    <FileDown className="w-4 h-4 flex-shrink-0" />
                    {displayName(file)}
                  </span>
                  <span className="text-xs bg-indigo-200 text-indigo-800 px-2 py-0.5 rounded-full flex-shrink-0 ml-2">
                    下载
                  </span>
                </a>
              ))}
            </div>
          )}

          {/* 其他文件（JSON 等）折叠显示 */}
          {otherFiles.length > 0 && (
            <div>
              <button
                className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700 transition"
                onClick={() => setShowAllFiles(!showAllFiles)}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                {showAllFiles ? "收起" : "展开"}其他 {otherFiles.length} 个文件（JSON 等）
                {showAllFiles ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>

              {showAllFiles && (
                <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-slate-100">
                  {otherFiles.map((file) => (
                    <div key={file}>
                      <div className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2 hover:bg-slate-100 transition">
                        <span className="flex-1 text-xs text-slate-600 truncate mr-2">{displayName(file)}</span>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {file.toLowerCase().endsWith('.json') && (
                            <button
                              onClick={() => previewJson(file)}
                              className="p-1 rounded hover:bg-slate-200 transition"
                              title="预览"
                            >
                              <Eye className={clsx("w-3.5 h-3.5", previewingJson === file ? "text-indigo-600" : "text-slate-400")} />
                            </button>
                          )}
                          <a
                            href={downloadLink(file)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 rounded hover:bg-slate-200 transition"
                            title="下载"
                          >
                            <FileDown className="w-3.5 h-3.5 text-slate-400" />
                          </a>
                        </div>
                      </div>
                      {/* JSON预览内容 */}
                      {previewingJson === file && (
                        <div className="mt-2 ml-4 bg-slate-900 rounded-lg p-3 max-h-96 overflow-auto">
                          {jsonLoading ? (
                            <div className="flex items-center gap-2 text-slate-400 text-xs">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              加载中...
                            </div>
                          ) : (
                            <pre className="text-xs text-green-400 font-mono">
                              {JSON.stringify(jsonContent, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {result.outputFiles.length === 0 && (
            <div className="text-sm text-slate-500">暂无输出文件</div>
          )}
        </div>
        );
}

        /* ─────────────────────────────────────────────────────────────────────
           历史记录面板
           ─────────────────────────────────────────────────────────────────── */

        function ReviewHistoryPanel({
          history,
          onView,
          onDelete,
}: {
          history: ReviewHistoryItem[];
  onView: (item: ReviewHistoryItem) => void;
  onDelete: (id: string) => void;
}) {
  if (history.length === 0) {
    return (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8 text-center">
          <Clock className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">暂无批阅历史</p>
          <p className="text-xs text-slate-400 mt-1">完成批阅后，评分表会自动保存在这里</p>
        </div>
        );
  }

        return (
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-8 py-5 border-b border-slate-100 flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center">
              <Clock className="w-5 h-5 text-slate-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">批阅历史</h2>
              <p className="text-xs text-slate-500">共 {history.length} 条记录，点击查看评分表</p>
            </div>
          </div>
          <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
            {history.map((item) => {
              // 从评分表计算摘要信息
              const studentCount = item.scoreTable.students.length;
              const avgScore = (() => {
                const means = item.scoreTable.students
                  .map((s) => s.mean)
                  .filter((m): m is number => m != null);
                return means.length > 0
                  ? (means.reduce((a, b) => a + b, 0) / means.length).toFixed(1)
                  : "—";
              })();

              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between px-8 py-4 hover:bg-slate-50 transition cursor-pointer group"
                  onClick={() => onView(item)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-800 truncate">
                        {item.fileNames.slice(0, 3).join(", ")}
                        {item.fileNames.length > 3 && ` 等${item.fileNames.length}个文件`}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                      <span>{new Date(item.timestamp).toLocaleString("zh-CN")}</span>
                      <span>{studentCount} 份作业</span>
                      <span>评测 {item.attempts} 次</span>
                      <span className="text-indigo-500 font-medium">均分 {avgScore}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={(e) => { e.stopPropagation(); onView(item); }}
                      className="p-1.5 rounded-lg hover:bg-indigo-50 text-slate-400 hover:text-indigo-600"
                      title="查看评分表"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm("确定删除这条批阅记录？")) onDelete(item.id);
                      }}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        );
}
