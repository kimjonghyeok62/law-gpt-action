import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { XMLParser } from "fast-xml-parser";
import { LawApiClient } from "./korean-law-mcp/build/lib/api-client.js";
import { getLawText } from "./korean-law-mcp/build/tools/law-text.js";
import { searchOrdinance } from "./korean-law-mcp/build/tools/ordinance-search.js";
import { getOrdinance } from "./korean-law-mcp/build/tools/ordinance.js";
import { searchPrecedents, getPrecedentText } from "./korean-law-mcp/build/tools/precedents.js";
import { searchHistoricalLaw } from "./korean-law-mcp/build/tools/historical-law.js";
import { getAnnexes } from "./korean-law-mcp/build/tools/annex.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ type: "application/json" }));

const PORT = process.env.PORT || 3000;
const ACTION_TOKEN = process.env.ACTION_TOKEN || "";
const LAW_OC = process.env.LAW_OC || "";

console.log("ACTION_TOKEN =", JSON.stringify(ACTION_TOKEN));
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

// 테스트 끝날 때까지 잠시 끔
// app.use(authMiddleware);

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
      normalizeText(findValueByKeyIncludes(item, ["법령명", "법령명한글"])) ||
      normalizeText(item.lawName);

    const lawId =
      normalizeText(findValueByKeyIncludes(item, ["법령ID"])) ||
      normalizeText(item.ID);

    const mst =
      normalizeText(findValueByKeyIncludes(item, ["법령일련번호"])) ||
      normalizeText(item.MST);

    const promulgationDate = normalizeText(findValueByKeyIncludes(item, ["공포일자", "공포일"]));
    const effectiveDate = normalizeText(findValueByKeyIncludes(item, ["시행일자", "시행일"]));
    const lawType =
      normalizeText(findValueByKeyIncludes(item, ["법령구분명", "법종구분", "법령종류"])) ||
      normalizeText(findValueByKeyIncludes(item, ["구분"]));
    const ministryName = normalizeText(findValueByKeyIncludes(item, ["소관부처명"]));

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
    keyword: root?.키워드 || root?.query,
    count: Number(root?.totalCnt || results.length || 0),
    results
  };
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Korean Law GPT Action API", endpoints: ["/law/search", "/law/text", "/law/three-tier", "/law/ordinance/search", "/law/ordinance/text", "/law/precedent/search", "/law/precedent/text", "/law/history"] });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "PARSED_DIRECT_IMPORT_SERVER",
    hasLawOc: !!LAW_OC,
    actionTokenRaw: ACTION_TOKEN
  });
});

app.post("/law/search", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "query가 필요합니다." });
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
      error: "searchLaw 실행 중 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/law/text", async (req, res) => {
  try {
    const { mst, lawId, jo, efYd } = req.body;

    if (!mst && !lawId) {
      return res.status(400).json({
        error: "mst 또는 lawId 중 하나는 필요합니다."
      });
    }

    const result = await getLawText(apiClient, {
      mst: mst ? String(mst) : undefined,
      lawId: lawId ? String(lawId) : undefined,
      jo: jo ? String(jo) : undefined,
      efYd: efYd ? String(efYd) : undefined,
      apiKey: LAW_OC
    });
    mcpToResponse(res, result);
  } catch (error) {
    res.status(500).json({
      error: "getLawText 실행 중 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/law/three-tier", async (req, res) => {
  try {
    const { mst, lawId, knd } = req.body;

    if (!mst && !lawId) {
      return res.status(400).json({
        error: "mst 또는 lawId 중 하나는 필요합니다."
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
      error: "getThreeTier 실행 중 오류",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

// MCP 도구 결과를 HTTP 응답으로 변환하는 헬퍼
// 항상 200 반환 — ChatGPT는 4xx를 "대화 오류"로 처리하므로 오류 내용은 text에 담음
function mcpToResponse(res, result) {
  const text = result.content?.[0]?.text ?? "";
  res.json({ success: !result.isError, text });
}

// ── 자치법규 ──────────────────────────────────────────────
app.post("/law/ordinance/search", async (req, res) => {
  try {
    const { query, display } = req.body;
    if (!query) return res.status(400).json({ error: "query가 필요합니다." });
    const result = await searchOrdinance(apiClient, { query, display: display ?? 20 });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/law/ordinance/text", async (req, res) => {
  try {
    const { ordinSeq, jo } = req.body;
    if (!ordinSeq) return res.status(400).json({ error: "ordinSeq가 필요합니다." });
    const result = await getOrdinance(apiClient, { ordinSeq: String(ordinSeq), jo });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 판례 ─────────────────────────────────────────────────
app.post("/law/precedent/search", async (req, res) => {
  try {
    const { query, court, display, page } = req.body;
    if (!query) return res.status(400).json({ error: "query가 필요합니다." });
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
    if (!id) return res.status(400).json({ error: "id(판례일련번호)가 필요합니다." });
    const result = await getPrecedentText(apiClient, { id: String(id) });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 법령 연혁 ─────────────────────────────────────────────
app.post("/law/history", async (req, res) => {
  try {
    const { lawName, display } = req.body;
    if (!lawName) return res.status(400).json({ error: "lawName이 필요합니다." });
    const result = await searchHistoricalLaw(apiClient, {
      lawName,
      display: display ?? 50,
    });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 별표/서식 ─────────────────────────────────────────────
app.post("/law/annex", async (req, res) => {
  try {
    const { lawName, knd, bylSeq, annexNo } = req.body;
    if (!lawName) return res.status(400).json({ error: "lawName이 필요합니다." });
    const result = await getAnnexes(apiClient, { lawName, knd, bylSeq, annexNo, apiKey: LAW_OC });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});