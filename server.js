import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";
import { LawApiClient } from "./korean-law-mcp/build/lib/api-client.js";
import { getLawText } from "./korean-law-mcp/build/tools/law-text.js";
import { searchOrdinance } from "./korean-law-mcp/build/tools/ordinance-search.js";
import { getOrdinance } from "./korean-law-mcp/build/tools/ordinance.js";
import { searchPrecedents, getPrecedentText } from "./korean-law-mcp/build/tools/precedents.js";
import { searchHistoricalLaw, getHistoricalLaw } from "./korean-law-mcp/build/tools/historical-law.js";
import { getAnnexes } from "./korean-law-mcp/build/tools/annex.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ type: "application/json" }));

// Minimal audit log: keep only route/meta, never raw 민원 원문 body
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const bodyText = req.body ? JSON.stringify(req.body) : "";
    const bodyHash = bodyText ? crypto.createHash("sha256").update(bodyText).digest("hex").slice(0, 12) : null;
    console.log(
      `[AUDIT] ${new Date().toISOString()} ${req.method} ${req.originalUrl} status=${res.statusCode} ms=${durationMs} bodyHash=${bodyHash}`
    );
  });
  next();
});

const PORT = process.env.PORT || 3000;
const ACTION_TOKEN = process.env.ACTION_TOKEN || "";
const LAW_OC = process.env.LAW_OC || "";

console.log("ACTION_TOKEN configured =", !!ACTION_TOKEN);
console.log("LAW_OC exists =", !!LAW_OC);

const apiClient = new LawApiClient({ apiKey: LAW_OC });

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true,
  cdataPropName: "#cdata"
});

function authMiddleware(req, res, next) {
  if (!ACTION_TOKEN) return next();

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${ACTION_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ?뚯뒪???앸궇 ?뚭퉴吏 ?좎떆 ??
app.use(authMiddleware);

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("#cdata" in value) return String(value["#cdata"]).trim();
    if ("content" in value) return String(value.content).trim();
  }
  return String(value).replace(/\r\n/g, "\n").trim();
}

function findValueByKeyIncludes(obj, includesList) {
  if (!obj || typeof obj !== "object") return undefined;

  for (const [key, value] of Object.entries(obj)) {
    const keyStr = String(key);
    if (includesList.some((part) => keyStr.includes(part))) {
      return value;
    }
  }
  return undefined;
}

function parseSearchLawXml(xmlText) {
  const parsed = xmlParser.parse(xmlText);
  const root = parsed?.LawSearch || parsed;
  const rawItems = root?.law || root?.Law || [];
  const items = toArray(rawItems);

  const results = items.map((item) => {
    const lawName =
      normalizeText(findValueByKeyIncludes(item, ["lawName", "법령명", "법령명한글"])) ||
      normalizeText(item.lawName || item["법령명한글"] || item["법령명"]);

    const lawId =
      normalizeText(findValueByKeyIncludes(item, ["lawId", "ID", "법령ID"])) ||
      normalizeText(item.ID || item["법령ID"]);

    const mst =
      normalizeText(findValueByKeyIncludes(item, ["MST", "법령일련번호"])) ||
      normalizeText(item.MST || item["법령일련번호"]);

    const promulgationDate = normalizeText(findValueByKeyIncludes(item, ["promulgationDate", "공포일자", "공포일"]));
    const effectiveDate = normalizeText(findValueByKeyIncludes(item, ["effectiveDate", "시행일자", "시행일"]));
    const lawType =
      normalizeText(findValueByKeyIncludes(item, ["lawType", "법령구분명", "법종구분", "법령종류"])) ||
      normalizeText(findValueByKeyIncludes(item, ["구분"]));
    const ministryName = normalizeText(findValueByKeyIncludes(item, ["소관부처명", "ministryName"]));

    return {
      lawName,
      lawId,
      mst,
      promulgationDate,
      effectiveDate,
      lawType,
      ministryName,
      raw: item
    };
  });

  return {
    target: root?.target,
    keyword: root?.query || root?.keyword,
    count: Number(root?.totalCnt || results.length || 0),
    results
  };
}

function formatYmdDot(raw) {
  const s = String(raw || "").replace(/[^0-9]/g, "");
  if (s.length !== 8) return String(raw || "");
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
}

function toYmd(raw) {
  const s = String(raw || "").replace(/[^0-9]/g, "");
  return s.length === 8 ? s : "";
}

function ymdYearsAgo(years) {
  const now = new Date();
  const d = new Date(now.getFullYear() - years, now.getMonth(), now.getDate());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function parseRecentYears({ recentYears, periodText }) {
  if (Number.isFinite(Number(recentYears)) && Number(recentYears) > 0) {
    return Math.min(30, Math.max(1, Number(recentYears)));
  }

  const text = String(periodText || "").trim();
  if (!text) return null;

  const exact = text.match(/최근\s*(\d{1,2})\s*년/);
  if (exact) return Math.min(30, Math.max(1, Number(exact[1])));

  const fuzzy = /(최근\s*몇\s*년|최근\s*수년|최근\s*몇년)/.test(text);
  if (fuzzy) return 3;

  return null;
}

function normalizeJoInput(jo) {
  const s = String(jo || "").trim();
  if (!s) return null;
  const m = s.match(/(\d+)(?:\D+(\d+))?/);
  if (!m) return null;
  return { article: Number(m[1]), branch: m[2] ? Number(m[2]) : 0 };
}

function formatJoDisplay(rawJoNo) {
  const digits = String(rawJoNo || "").replace(/[^0-9]/g, "");
  if (digits.length === 6) {
    const article = Number(digits.slice(0, 4));
    const branch = Number(digits.slice(4, 6));
    return branch > 0 ? `제${article}조의${branch}` : `제${article}조`;
  }
  if (/^\d+$/.test(digits)) return `제${Number(digits)}조`;
  return String(rawJoNo || "");
}

function joMatches(recordJoNo, recordDisplay, inputJo) {
  if (!inputJo) return true;
  const target = normalizeJoInput(inputJo);
  if (!target) return true;
  const recDigits = String(recordJoNo || "").replace(/[^0-9]/g, "");

  if (recDigits.length === 6) {
    const article = Number(recDigits.slice(0, 4));
    const branch = Number(recDigits.slice(4, 6));
    return article === target.article && branch === target.branch;
  }

  const displayNorm = String(recordDisplay || "").replace(/\s/g, "");
  const targetLabel = target.branch > 0 ? `제${target.article}조의${target.branch}` : `제${target.article}조`;
  return displayNorm.includes(targetLabel);
}

function collectLawNodes(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    obj.forEach((v) => collectLawNodes(v, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "law" || k === "Law") {
      toArray(v).forEach((n) => out.push(n));
    } else if (v && typeof v === "object") {
      collectLawNodes(v, out);
    }
  }
  return out;
}

function pickByIncludes(obj, includesList) {
  if (!obj || typeof obj !== "object") return "";
  for (const [key, value] of Object.entries(obj)) {
    const keyStr = String(key);
    if (includesList.some((part) => keyStr.includes(part))) {
      return normalizeText(value);
    }
  }
  return "";
}

function tokenizeKoreanText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function classifyCivilQuestion(question) {
  const q = String(question || "");
  const rules = [
    { category: "인허가", keywords: ["허가", "인가", "등록", "신고", "승인", "면허"] },
    { category: "행정처분", keywords: ["처분", "과태료", "영업정지", "취소", "시정명령", "행정벌"] },
    { category: "계약", keywords: ["계약", "입찰", "낙찰", "계약해지", "용역", "공사"] },
    { category: "인사", keywords: ["징계", "인사", "전보", "승진", "채용", "휴직"] },
    { category: "복무", keywords: ["복무", "근태", "출장", "연가", "당직", "초과근무"] }
  ];

  for (const rule of rules) {
    if (rule.keywords.some((k) => q.includes(k))) return rule.category;
  }
  return "일반행정";
}

function inferJurisdictionAndPriority(lawResults) {
  const text = lawResults.map((r) => `${r.lawType || ""} ${r.lawName || ""}`).join(" ");
  const hasOrdinance = /조례|규칙|자치/.test(text);
  const hasAdminRule = /훈령|고시|예규|행정규칙/.test(text);
  const hasNational = /법률|시행령|시행규칙|법/.test(text);

  const priority = [];
  if (hasNational) priority.push("국가법령");
  if (hasOrdinance) priority.push("자치법규");
  if (hasAdminRule) priority.push("행정규칙");

  let guidance = "국가법령 > 자치법규 > 행정규칙 순서로 충돌 여부를 확인하세요.";
  if (hasOrdinance && !hasNational) {
    guidance = "자치법규 중심 사안입니다. 상위법 위임 범위와 충돌 여부를 우선 확인하세요.";
  }

  return { priority, guidance };
}

function buildLawSourceLinks(lawName) {
  const q = encodeURIComponent(String(lawName || ""));
  return {
    search: `https://www.law.go.kr/lsSc.do?query=${q}`,
    direct: `https://www.law.go.kr/법령/${q}`
  };
}

function selectInternalRules(internalRules, question, maxCount = 3) {
  const qTokens = new Set(tokenizeKoreanText(question));
  const normalized = Array.isArray(internalRules) ? internalRules : [];
  const candidates = normalized.map((item, idx) => {
    const title = typeof item === "string" ? `내부기준-${idx + 1}` : String(item?.title || `내부기준-${idx + 1}`);
    const content = typeof item === "string" ? item : String(item?.content || "");
    const tokens = tokenizeKoreanText(`${title} ${content}`);
    const overlap = tokens.filter((t) => qTokens.has(t)).length;
    return { title, content, overlap };
  });

  return candidates
    .filter((c) => c.overlap > 0 || c.content.length > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, maxCount)
    .map((c) => ({
      title: c.title,
      excerpt: c.content.slice(0, 240),
      relevance: c.overlap
    }));
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Korean Law GPT Action API", endpoints: ["/law/search", "/law/text", "/law/three-tier", "/law/ordinance/search", "/law/ordinance/text", "/law/precedent/search", "/law/precedent/text", "/law/annex", "/law/history", "/law/history/text", "/law/article-history", "/gov/assistant"] });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "PARSED_DIRECT_IMPORT_SERVER",
    hasLawOc: !!LAW_OC,
    hasActionToken: !!ACTION_TOKEN
  });
});

app.post("/law/search", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "query媛 ?꾩슂?⑸땲??" });
    }

    const raw = await apiClient.searchLaw(String(query), LAW_OC);
    const parsed = parseSearchLawXml(raw);

    res.json({
      success: true,
      tool: "searchLaw",
      query,
      ...parsed
    });
  } catch (error) {
    res.status(500).json({
      error: "searchLaw ?ㅽ뻾 以??ㅻ쪟",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/law/text", async (req, res) => {
  try {
    const { mst, lawId, lawName, jo, efYd } = req.body;

    if (!mst && !lawId && !lawName) {
      return res.status(400).json({
        error: "mst ?먮뒗 lawId 以??섎굹???꾩슂?⑸땲??"
      });
    }

    const result = await getLawText(apiClient, {
      mst: mst ? String(mst) : undefined,
      lawId: lawId ? String(lawId) : undefined,
      lawName: lawName ? String(lawName) : undefined,
      jo: jo ? String(jo) : undefined,
      efYd: efYd ? String(efYd) : undefined,
      apiKey: LAW_OC
    });
    const rawText = result.content?.[0]?.text ?? "";
    const meta = extractLawTextMeta(rawText, { lawNameHint: lawName, joHint: jo });
    const links = buildArticleLinks(meta.lawName, meta.joDisplay);
    const formattedText = formatLawTextSimple(rawText, { lawNameHint: lawName, joHint: jo });
    res.json({
      success: !result.isError,
      asOfDate: new Date().toISOString().slice(0, 10),
      text: formattedText,
      links
    });
  } catch (error) {
    res.status(500).json({
      error: "getLawText ?ㅽ뻾 以??ㅻ쪟",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/law/three-tier", async (req, res) => {
  try {
    const { mst, lawId, knd } = req.body;

    if (!mst && !lawId) {
      return res.status(400).json({
        error: "mst ?먮뒗 lawId 以??섎굹???꾩슂?⑸땲??"
      });
    }

    const raw = await apiClient.getThreeTier({
      mst: mst ? String(mst) : undefined,
      lawId: lawId ? String(lawId) : undefined,
      knd: knd ? String(knd) : "2",
      apiKey: LAW_OC
    });

    res.json({
      success: true,
      tool: "getThreeTier",
      input: { mst, lawId, knd },
      raw: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)
    });
  } catch (error) {
    res.status(500).json({
      error: "getThreeTier ?ㅽ뻾 以??ㅻ쪟",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

// MCP ?꾧뎄 寃곌낵瑜?HTTP ?묐떟?쇰줈 蹂?섑븯???ы띁
// ??긽 200 諛섑솚 ??ChatGPT??4xx瑜?"????ㅻ쪟"濡?泥섎━?섎?濡??ㅻ쪟 ?댁슜? text???댁쓬
function mcpToResponse(res, result) {
  const text = result.content?.[0]?.text ?? "";
  res.json({ success: !result.isError, asOfDate: new Date().toISOString().slice(0, 10), text });
}

function extractLawTextMeta(rawText, options = {}) {
  const text = String(rawText || "").replace(/\r\n/g, "\n");
  const lawNameFromText = (text.match(/법령명\s*[:：]\s*(.+)/)?.[1] || "").trim();
  const lawName = lawNameFromText || String(options.lawNameHint || "").trim() || "요청하신 법령";
  const headerMatch = text.match(/^제\s*\d+조(?:의\s*\d+)?\s*\([^)]+\)/m);
  const joDisplay = (headerMatch?.[0].match(/제\s*\d+조(?:의\s*\d+)?/)?.[0] || String(options.joHint || "").trim() || "").replace(/\s+/g, "");
  return { lawName, joDisplay };
}

function buildArticleLinks(lawName, joDisplay) {
  const base = buildLawSourceLinks(lawName);
  const query = encodeURIComponent(`${lawName} ${joDisplay}`.trim());
  return {
    ...base,
    articleSearch: `https://www.law.go.kr/lsSc.do?query=${query}`
  };
}

function formatLawTextSimple(rawText, options = {}) {
  const text = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return text;

  const meta = extractLawTextMeta(text, options);
  const lawName = meta.lawName;

  const articleHeaderRegex = /^제\s*\d+조(?:의\s*\d+)?\s*\([^)]+\)/m;
  const headerMatch = text.match(articleHeaderRegex);
  if (!headerMatch || headerMatch.index == null) {
    return text;
  }

  const articleStart = headerMatch.index;
  const afterHeader = text.slice(articleStart + headerMatch[0].length);
  const nextHeaderRel = afterHeader.search(/\n제\s*\d+조(?:의\s*\d+)?\s*\([^)]+\)/);
  const articleEnd = nextHeaderRel >= 0 ? articleStart + headerMatch[0].length + nextHeaderRel : text.length;
  const articleBlock = text.slice(articleStart, articleEnd).trim();

  const joDisplay = (headerMatch[0].match(/제\s*\d+조(?:의\s*\d+)?/)?.[0] || meta.joDisplay || "해당 조문")
    .replace(/\s+/g, "");
  const links = buildArticleLinks(lawName, joDisplay);

  let out = `${lawName} ${joDisplay} 조문입니다.\n\n${articleBlock}\n\n조문 링크: ${links.articleSearch}`;

  if (/대통령령으로\s*정하는\s*바/.test(articleBlock)) {
    out += `\n\n"대통령령으로 정하는 바"가 필요하시면 관련 시행령 조문을 추가로 조회해 드릴 수 있습니다. 필요하시면 말씀해 주세요!`;
  } else if (/(총리령|부령|교육부령)으로\s*정하는\s*바/.test(articleBlock)) {
    out += `\n\n"부령/총리령으로 정하는 바"가 필요하시면 관련 시행규칙 조문을 추가로 조회해 드릴 수 있습니다. 필요하시면 말씀해 주세요!`;
  }

  return out.trim();
}

app.post("/gov/assistant", async (req, res) => {
  try {
    const { question, internalRules, maxResults } = req.body || {};
    if (!question || !String(question).trim()) {
      return res.status(400).json({ success: false, error: "question is required" });
    }

    const category = classifyCivilQuestion(question);
    const asOfDate = new Date().toISOString().slice(0, 10);
    const resultLimit = Number.isFinite(Number(maxResults)) ? Math.max(1, Math.min(10, Number(maxResults))) : 5;

    const searchRaw = await apiClient.searchLaw(String(question), LAW_OC);
    const parsed = parseSearchLawXml(searchRaw);
    const lawResults = (parsed.results || []).slice(0, resultLimit);
    const jurisdiction = inferJurisdictionAndPriority(lawResults);
    const matchedInternalRules = selectInternalRules(internalRules, question, 3);

    const lawSources = lawResults.map((r) => ({
      type: "law",
      lawName: r.lawName,
      lawId: r.lawId,
      mst: r.mst,
      ...buildLawSourceLinks(r.lawName)
    }));
    const internalSources = matchedInternalRules.map((r) => ({
      type: "internal_rule",
      title: r.title,
      excerpt: r.excerpt
    }));
    const sources = [...lawSources, ...internalSources];

    // Disable source-less summary mode
    if (sources.length === 0) {
      return res.json({
        success: false,
        asOfDate,
        error: "출처가 확인되지 않아 요약을 생성하지 않았습니다.",
        sourceRequired: true
      });
    }

    // Keep response structured and concise (disable long free-form priority)
    const summary = [
      `${category} 유형으로 분류되었습니다.`,
      `${jurisdiction.guidance}`,
      `기준일: ${asOfDate}`
    ].join(" ");

    return res.json({
      success: true,
      asOfDate,
      sourceRequired: true,
      classification: category,
      jurisdiction,
      summary: summary.slice(0, 500),
      laws: lawResults.map((r) => ({
        lawName: r.lawName,
        lawId: r.lawId,
        mst: r.mst,
        lawType: r.lawType,
        promulgationDate: r.promulgationDate,
        effectiveDate: r.effectiveDate,
        links: buildLawSourceLinks(r.lawName)
      })),
      internalRuleMatches: matchedInternalRules,
      sources
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      asOfDate: new Date().toISOString().slice(0, 10),
      error: e instanceof Error ? e.message : String(e)
    });
  }
});

// ?? ?먯튂踰뺢퇋 ??????????????????????????????????????????????
app.post("/law/ordinance/search", async (req, res) => {
  try {
    const { query, display } = req.body;
    if (!query) return res.status(400).json({ error: "query媛 ?꾩슂?⑸땲??" });
    const result = await searchOrdinance(apiClient, { query, display: display ?? 20 });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/law/ordinance/text", async (req, res) => {
  try {
    const { ordinSeq, jo } = req.body;
    if (!ordinSeq) return res.status(400).json({ error: "ordinSeq媛 ?꾩슂?⑸땲??" });
    const result = await getOrdinance(apiClient, { ordinSeq: String(ordinSeq), jo });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ?? ?먮? ?????????????????????????????????????????????????
app.post("/law/precedent/search", async (req, res) => {
  try {
    const { query, court, display, page } = req.body;
    if (!query) return res.status(400).json({ error: "query媛 ?꾩슂?⑸땲??" });
    const result = await searchPrecedents(apiClient, {
      query,
      court,
      display: display ?? 20,
      page: page ?? 1,
    });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/law/precedent/text", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "id(?먮??쇰젴踰덊샇)媛 ?꾩슂?⑸땲??" });
    const result = await getPrecedentText(apiClient, { id: String(id) });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ?? 踰뺣졊 ?고쁺 ?????????????????????????????????????????????
app.post("/law/history", async (req, res) => {
  try {
    const { lawName, display } = req.body;
    if (!lawName) return res.status(400).json({ error: "lawName???꾩슂?⑸땲??" });
    const result = await searchHistoricalLaw(apiClient, {
      lawName,
      display: display ?? 50,
    });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ?? 蹂꾪몴/?쒖떇 ?????????????????????????????????????????????
app.post("/law/annex", async (req, res) => {
  try {
    const { lawName, knd, bylSeq, annexNo } = req.body;
    if (!lawName) return res.status(400).json({ error: "lawName???꾩슂?⑸땲??" });

    // ?⑥텞 踰뺣졊紐???怨듭떇 ?꾩껜紐??댁꽍
    // ?? "?숈썝踰??쒗뻾洹쒖튃" ??"?숈썝???ㅻ┰쨌?댁쁺 諛?怨쇱쇅援먯뒿??愿??踰뺣쪧 ?쒗뻾洹쒖튃"
    let resolvedName = String(lawName);
    try {
      const searchRaw = await apiClient.searchLaw(resolvedName, LAW_OC);
      const parsed = parseSearchLawXml(searchRaw);
      if (parsed.results.length > 0) {
        const normalizedInput = resolvedName.replace(/\s/g, "");
        const exact = parsed.results.find(
          r => r.lawName && r.lawName.replace(/\s/g, "") === normalizedInput
        );
        const best = exact || parsed.results[0];
        if (best?.lawName) resolvedName = best.lawName;
      }
    } catch (_) { /* 寃???ㅽ뙣 ???먮옒 ?대쫫 ?좎? */ }

    const result = await getAnnexes(apiClient, { lawName: resolvedName, knd, bylSeq, annexNo, apiKey: LAW_OC });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ?? 議곕Ц蹂?媛쒖젙 ?대젰 ?????????????????????????????????????
// lsJoHstInf API媛 ?踰뺢컻?????쇰? ?좏삎???꾨씫?섎?濡?
// searchHistoricalLaw ??getHistoricalLaw 泥댁씤?쇰줈 ?ш뎄??
app.post("/law/article-history", async (req, res) => {
  try {
    const { lawName, lawId, jo, fromRegDt, toRegDt, recentYears, periodText, limit } = req.body;
    if (!lawName && !lawId) return res.status(400).json({ error: "lawName 또는 lawId가 필요합니다." });

    let resolvedLawId = lawId ? String(lawId) : undefined;
    let resolvedLawName = lawName ? String(lawName) : undefined;
    if (!resolvedLawId && resolvedLawName) {
      const raw = await apiClient.searchLaw(resolvedLawName, LAW_OC);
      const parsedSearch = parseSearchLawXml(raw);
      const normalized = resolvedLawName.replace(/\s/g, "");
      const exact = parsedSearch.results.find((r) => (r.lawName || "").replace(/\s/g, "") === normalized);
      const pick = exact || parsedSearch.results[0];
      if (!pick?.lawId) {
        return res.json({ success: false, text: `'${resolvedLawName}' 법령을 찾지 못했습니다.` });
      }
      resolvedLawId = pick.lawId;
      resolvedLawName = pick.lawName || resolvedLawName;
    }

    const inferredYears = parseRecentYears({ recentYears, periodText });
    const effectiveFromRegDt = fromRegDt
      ? String(fromRegDt)
      : (inferredYears ? ymdYearsAgo(inferredYears) : undefined);
    const effectiveToRegDt = toRegDt ? String(toRegDt) : undefined;
    const pageLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Number(limit))) : 10;

    const rawXml = await apiClient.getArticleHistory({
      lawId: resolvedLawId,
      jo: undefined,
      fromRegDt: effectiveFromRegDt,
      toRegDt: effectiveToRegDt,
      page: 1,
      apiKey: LAW_OC
    });

    const parsed = xmlParser.parse(rawXml);
    const lawNodes = collectLawNodes(parsed);
    if (lawNodes.length === 0) {
      return res.json({ success: false, text: "개정 이력이 없습니다." });
    }

    const records = [];
    for (const lawNode of lawNodes) {
      const lawInfo = lawNode["법령정보"] || lawNode.lawInfo || lawNode["LawInfo"] || {};
      const lawNameFromRow =
        pickByIncludes(lawInfo, ["법령명한글", "법령명", "lawName"]) ||
        String(resolvedLawName || "");
      const lawIdFromRow = pickByIncludes(lawInfo, ["법령ID", "lawId", "ID"]) || String(resolvedLawId || "");
      const mst = pickByIncludes(lawInfo, ["법령일련번호", "MST"]);
      const promulgationDate = pickByIncludes(lawInfo, ["공포일자", "promulgationDate"]);

      const joNodes = toArray(lawNode.jo || lawNode.JO || lawNode["조"] || []);
      for (const joNode of joNodes) {
        const joNo = pickByIncludes(joNode, ["조문번호", "joNo", "JO"]);
        const joDisplay = formatJoDisplay(joNo);
        if (!joMatches(joNo, joDisplay, jo)) continue;

        const joRegDt = pickByIncludes(joNode, ["조문개정일", "regDt", "개정일"]);
        const joEffDt = pickByIncludes(joNode, ["조문시행일", "effDt", "시행일"]);
        const changeReason = pickByIncludes(joNode, ["변경사유", "changeReason"]);

        records.push({
          lawName: lawNameFromRow,
          lawId: lawIdFromRow,
          mst,
          joNo,
          joDisplay,
          joRegDt,
          joEffDt,
          promulgationDate,
          changeReason
        });
      }
    }

    if (records.length === 0) {
      return res.json({ success: false, text: "요청한 조항의 개정 이력이 없습니다." });
    }

    records.sort((a, b) => {
      const aDate = toYmd(a.joRegDt) || toYmd(a.promulgationDate) || "00000000";
      const bDate = toYmd(b.joRegDt) || toYmd(b.promulgationDate) || "00000000";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return String(b.mst || "").localeCompare(String(a.mst || ""));
    });

    const sliced = records.slice(0, pageLimit);
    const scopeText = effectiveFromRegDt
      ? `조회기간: ${formatYmdDot(effectiveFromRegDt)} ~ ${effectiveToRegDt ? formatYmdDot(effectiveToRegDt) : "현재"}\n`
      : "조회기간: 전체(최신순)\n";

    let text = `${sliced[0].lawName || lawName || lawId} 조문 개정이력 (최신순)\n${scopeText}\n`;
    sliced.forEach((r, idx) => {
      text += `${idx + 1}. ${r.joDisplay}\n`;
      text += `   - 개정일: ${formatYmdDot(r.joRegDt || r.promulgationDate || "") || "정보없음"}\n`;
      text += `   - 시행일: ${formatYmdDot(r.joEffDt || "") || "정보없음"}\n`;
      if (r.changeReason) text += `   - 변경사유: ${r.changeReason}\n`;
      if (r.lawId || r.mst) text += `   - lawId: ${r.lawId || "-"}, MST: ${r.mst || "-"}\n`;
      text += "\n";
    });

    if (records.length > sliced.length) {
      text += `... 총 ${records.length}건 중 ${sliced.length}건 표시\n`;
    }

    return res.json({ success: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/law/history/text", async (req, res) => {
  try {
    const { mst, jo } = req.body;
    if (!mst) return res.status(400).json({ error: "mst媛 ?꾩슂?⑸땲??" });
    const result = await getHistoricalLaw(apiClient, { mst: String(mst), jo, apiKey: LAW_OC });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
