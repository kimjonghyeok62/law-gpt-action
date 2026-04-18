import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { XMLParser } from "fast-xml-parser";
import { LawApiClient } from "./korean-law-mcp/build/lib/api-client.js";
import { buildJO } from "./korean-law-mcp/build/lib/law-parser.js";
import { flattenContent, extractHangContent, cleanHtml } from "./korean-law-mcp/build/lib/article-parser.js";

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

function findNestedObjectByKeyIncludes(obj, includesList) {
  if (!obj || typeof obj !== "object") return undefined;

  for (const [key, value] of Object.entries(obj)) {
    const keyStr = String(key);
    if (includesList.some((part) => keyStr.includes(part))) {
      return value;
    }
    if (value && typeof value === "object") {
      const nested = findNestedObjectByKeyIncludes(value, includesList);
      if (nested !== undefined) return nested;
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

function extractBasicInfo(lawRoot) {
  const basic =
    lawRoot?.기본정보 ||
    findNestedObjectByKeyIncludes(lawRoot, ["기본정보"]) ||
    {};

  const lawName =
    normalizeText(findValueByKeyIncludes(basic, ["법령명_한글", "법령명한글", "법령명"])) ||
    normalizeText(findValueByKeyIncludes(lawRoot, ["법령명_한글", "법령명한글", "법령명"]));

  const lawId =
    normalizeText(findValueByKeyIncludes(basic, ["법령ID"])) ||
    normalizeText(findValueByKeyIncludes(lawRoot, ["법령ID"]));

  const promulgationDate =
    normalizeText(findValueByKeyIncludes(basic, ["공포일자", "공포일"])) ||
    normalizeText(findValueByKeyIncludes(lawRoot, ["공포일자", "공포일"]));

  const effectiveDate =
    normalizeText(findValueByKeyIncludes(basic, ["시행일자", "시행일"])) ||
    normalizeText(findValueByKeyIncludes(lawRoot, ["시행일자", "시행일"]));

  let lawType = findValueByKeyIncludes(basic, ["법종구분", "법령구분"]);
  if (lawType && typeof lawType === "object") {
    lawType = lawType.content ?? lawType["content"] ?? lawType;
  }

  const ministry = findValueByKeyIncludes(basic, ["소관부처"]);
  let ministryName = "";
  if (ministry && typeof ministry === "object") {
    ministryName = normalizeText(ministry.content ?? ministry["content"]);
  } else {
    ministryName = normalizeText(findValueByKeyIncludes(basic, ["소관부처명"]));
  }

  return {
    lawName,
    lawId,
    promulgationDate,
    effectiveDate,
    lawType: normalizeText(lawType),
    ministryName
  };
}

function extractArticleInfo(parsed) {
  const lawRoot = parsed?.법령 || parsed?.Law || parsed;

  const articleContainer =
    findNestedObjectByKeyIncludes(lawRoot, ["조문"]) ||
    findNestedObjectByKeyIncludes(parsed, ["조문"]) ||
    {};

  const unitRaw = articleContainer?.조문단위 || articleContainer?.조문 || articleContainer;
  const units = toArray(unitRaw);

  // 조문여부 === "조문"인 항목 우선, 없으면 첫 번째
  const articleUnit = units.find(u => u?.조문여부 === "조문") || units[0] || {};

  const articleNumber = normalizeText(articleUnit.조문번호 || articleUnit.조문가지번호
    ? (articleUnit.조문가지번호 && articleUnit.조문가지번호 !== "0"
        ? `제${articleUnit.조문번호}조의${articleUnit.조문가지번호}`
        : `제${articleUnit.조문번호}조`)
    : findValueByKeyIncludes(articleUnit, ["조문번호", "조번호"])
  );

  const title = normalizeText(
    articleUnit.조문제목 || findValueByKeyIncludes(articleUnit, ["조문제목", "조제목", "제목"])
  );

  // 조문내용은 배열일 수 있으므로 flattenContent 사용
  const rawContent = articleUnit.조문내용 ?? findValueByKeyIncludes(articleUnit, ["조문내용", "조문본문"]);
  const body = rawContent != null
    ? cleanHtml(typeof rawContent === "string" ? rawContent : flattenContent(rawContent))
    : "";

  // 항 처리: 항내용도 배열일 수 있음
  const paraRaw = articleUnit.항 || findValueByKeyIncludes(articleUnit, ["항"]);
  const paraArray = toArray(paraRaw);

  const paragraphs = paraArray.map((p) => ({
    number: normalizeText(p.항번호 || findValueByKeyIncludes(p, ["항번호", "번호"])),
    text: cleanHtml(extractHangContent(p))
  }));

  return { articleNumber, title, body, paragraphs };
}

function parseLawTextJson(rawText) {
  const parsed = JSON.parse(rawText);
  const lawRoot = parsed?.법령 || parsed?.Law || parsed;

  return {
    ...extractBasicInfo(lawRoot),
    ...extractArticleInfo(parsed),
    raw: parsed
  };
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Korean Law GPT Action API", endpoints: ["/law/search", "/law/text", "/law/three-tier"] });
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

    let joCode = jo ? String(jo) : undefined;
    if (joCode && !/^\d{6}$/.test(joCode)) {
      try { joCode = buildJO(joCode); } catch { /* 변환 실패 시 원본 사용 */ }
    }

    const raw = await apiClient.getLawText({
      mst: mst ? String(mst) : undefined,
      lawId: lawId ? String(lawId) : undefined,
      jo: joCode,
      efYd: efYd ? String(efYd) : undefined,
      apiKey: LAW_OC
    });

    const parsed = parseLawTextJson(raw);

    res.json({
      success: true,
      tool: "getLawText",
      input: { mst, lawId, jo, efYd },
      ...parsed
    });
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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});