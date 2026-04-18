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

// Minimal audit log: keep only route/meta, never raw 誘쇱썝 ?먮Ц body
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

// ???뮞????멸텊 ???돱筌왖 ?醫롫뻻 ??
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
      normalizeText(findValueByKeyIncludes(item, ["lawName", "\uBC95\uB839\uBA85", "\uBC95\uB839\uBA85\uD55C\uAE00"])) ||
      normalizeText(item.lawName || item["\uBC95\uB839\uBA85\uD55C\uAE00"] || item["\uBC95\uB839\uBA85"]);

    const lawId =
      normalizeText(findValueByKeyIncludes(item, ["lawId", "ID", "\uBC95\uB839ID"])) ||
      normalizeText(item.ID || item["\uBC95\uB839ID"]);

    const mst =
      normalizeText(findValueByKeyIncludes(item, ["MST", "\uBC95\uB839\uC77C\uB828\uBC88\uD638"])) ||
      normalizeText(item.MST || item["\uBC95\uB839\uC77C\uB828\uBC88\uD638"]);

    const promulgationDate = normalizeText(findValueByKeyIncludes(item, ["promulgationDate", "\uACF5\uD3EC\uC77C\uC790", "\uACF5\uD3EC\uC77C"]));
    const effectiveDate = normalizeText(findValueByKeyIncludes(item, ["effectiveDate", "\uC2DC\uD589\uC77C\uC790", "\uC2DC\uD589\uC77C"]));
    const lawType =
      normalizeText(findValueByKeyIncludes(item, ["lawType", "\uBC95\uB839\uAD6C\uBD84\uBA85", "\uBC95\uC885\uAD6C\uBD84", "\uBC95\uB839\uC885\uB958"])) ||
      normalizeText(findValueByKeyIncludes(item, ["\uAD6C\uBD84"]));
    const ministryName = normalizeText(findValueByKeyIncludes(item, ["\uC18C\uAD00\uBD80\uCC98\uBA85", "ministryName"]));

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

app.get("/privacy", (req, res) => {
  res.type("text/html").send(`
    <h1>개인정보 보호정책</h1>
    <p>본 서비스는 법령 조회 목적으로만 운영되며, 사용자의 개인정보를 수집·저장하지 않습니다.</p>
    <p>모든 법령 데이터는 국가법령정보센터(law.go.kr) 공공 API를 통해 실시간 조회됩니다.</p>
    <p>문의: hyok96@gmail.com</p>
  `);
});

app.post("/law/search", async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "query揶쎛 ?袁⑹뒄??몃빍??" });
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
      error: "searchLaw ??쎈뻬 餓???살첒",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/law/text", async (req, res) => {
  try {
    const { mst, lawId, lawName, jo, efYd, includeRelated } = req.body;

    if (!mst && !lawId && !lawName) {
      return res.status(400).json({
        error: "mst ?癒?뮉 lawId 餓???롪돌???袁⑹뒄??몃빍??"
      });
    }

    // Stabilize identifier resolution: resolve lawName -> mst/lawId at server layer first.
    let resolvedMst = mst ? String(mst) : undefined;
    let resolvedLawId = lawId ? String(lawId) : undefined;
    let resolvedLawName = lawName ? String(lawName) : undefined;

    if (!resolvedMst && !resolvedLawId && resolvedLawName) {
      const searchRaw = await apiClient.searchLaw(resolvedLawName, LAW_OC);
      const parsed = parseSearchLawXml(searchRaw);
      if (!parsed.results || parsed.results.length === 0) {
        return res.json({
          success: false,
          asOfDate: new Date().toISOString().slice(0, 10),
          text: `'${resolvedLawName}' 법령을 찾을 수 없습니다. 법령명을 확인해 주세요.`
        });
      }

      const normalizedInput = resolvedLawName.replace(/\s/g, "");
      const exact = parsed.results.find((r) => String(r.lawName || "").replace(/\s/g, "") === normalizedInput);
      const best = exact || parsed.results[0];
      resolvedMst = best?.mst ? String(best.mst) : undefined;
      resolvedLawId = best?.lawId ? String(best.lawId) : undefined;
      resolvedLawName = best?.lawName || resolvedLawName;
    }

    const joParsed = parseJoAndClause(jo);

    const result = await getLawText(apiClient, {
      mst: resolvedMst,
      lawId: resolvedLawId,
      lawName: resolvedLawName,
      jo: joParsed.joForLookup ? String(joParsed.joForLookup) : undefined,
      efYd: efYd ? String(efYd) : undefined,
      apiKey: LAW_OC
    });
    const rawText = result.content?.[0]?.text ?? "";

    // Never fail request only because formatting failed; fallback to raw text.
    try {
      const meta = extractLawTextMeta(rawText, { lawNameHint: resolvedLawName, joHint: joParsed.joForLookup || jo });
      const links = buildArticleLinks(meta.lawName, meta.joDisplay);
      const delegatedLinks = buildDelegatedLinks(rawText, meta.lawName, meta.joDisplay, true);
      const formattedText = formatLawTextSimple(rawText, {
        lawNameHint: resolvedLawName,
        joHint: joParsed.joForLookup || jo,
        clauseNo: joParsed.clauseNo
      });

      let finalText = formattedText;
      let relatedSections = [];
      const needRelated = includeRelated !== false && includeRelated !== "false" && includeRelated !== 0;
      if (needRelated && delegatedLinks.length > 0) {
        const targets = delegatedLinks.slice(0, 2); // 시행령/시행규칙
        relatedSections = await Promise.all(
          targets.map(async (d) => {
            try {
              const rr = await getLawText(apiClient, {
                lawName: d.lawName,
                jo: d.jo,
                apiKey: LAW_OC
              });
              const rraw = rr.content?.[0]?.text ?? "";
              const rtxt = formatLawTextSimple(rraw, { lawNameHint: d.lawName, joHint: d.jo });
              return {
                kind: d.kind,
                lawName: d.lawName,
                jo: d.jo,
                text: rtxt,
                link: d.articleDirect
              };
            } catch {
              return {
                kind: d.kind,
                lawName: d.lawName,
                jo: d.jo,
                text: `${d.lawName} ${d.jo || ""} 조회 중 오류가 발생했습니다.`,
                link: d.articleDirect
              };
            }
          })
        );
      }

      if (relatedSections.length > 0) {
        finalText += `\n\n---\n\n**관련 법령 동시 조회 결과**\n\n`;
        finalText += relatedSections
          .map((s) => `### ${s.kind}\n${s.text}`)
          .join("\n\n");
      }

      finalText += `\n\n${buildLinkSummarySection(links, delegatedLinks, relatedSections)}`;
      const quickLinks = buildQuickLinks(links, delegatedLinks, relatedSections);

      res.json({
        success: true,
        asOfDate: new Date().toISOString().slice(0, 10),
        mustDisplayVerbatim: true,
        mustShowLinks: true,
        displayPolicy: "verbatim_markdown",
        responseFormat: "markdown",
        text: finalText,
        quickLinks,
        links: {
          ...links,
          delegated: delegatedLinks,
          relatedFetched: relatedSections.length > 0
        }
      });
    } catch (_) {
      const meta = extractLawTextMeta(rawText, { lawNameHint: resolvedLawName, joHint: joParsed.joForLookup || jo });
      const links = buildArticleLinks(meta.lawName, meta.joDisplay);
      const delegatedLinks = buildDelegatedLinks(rawText, meta.lawName, meta.joDisplay, true);
      const linkSection = buildLinkSummarySection(links, delegatedLinks, []);
      const quickLinks = buildQuickLinks(links, delegatedLinks, []);
      res.json({
        success: !!rawText,
        asOfDate: new Date().toISOString().slice(0, 10),
        mustDisplayVerbatim: true,
        mustShowLinks: true,
        displayPolicy: "verbatim_markdown",
        responseFormat: "markdown",
        text: `${rawText}\n\n${linkSection}`.trim(),
        quickLinks
      });
    }
  } catch (error) {
    res.status(500).json({
      error: "getLawText ??쎈뻬 餓???살첒",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/law/three-tier", async (req, res) => {
  try {
    const { mst, lawId, knd } = req.body;

    if (!mst && !lawId) {
      return res.status(400).json({
        error: "mst ?癒?뮉 lawId 餓???롪돌???袁⑹뒄??몃빍??"
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
      error: "getThreeTier ??쎈뻬 餓???살첒",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

// MCP ?袁㏓럡 野껉퀗?든몴?HTTP ?臾먮뼗??곗쨮 癰궰??묐릭??????
// ??湲?200 獄쏆꼹????ChatGPT??4xx??"??????살첒"嚥?筌ｌ꼶????嚥???살첒 ??곸뒠?? text????곸벉
function mcpToResponse(res, result) {
  const text = result.content?.[0]?.text ?? "";
  res.json({
    success: !result.isError,
    asOfDate: new Date().toISOString().slice(0, 10),
    mustDisplayVerbatim: true,
    displayPolicy: "verbatim_markdown",
    responseFormat: "markdown",
    text
  });
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
  const base = buildLawSourceLinks(lawName)
  const query = encodeURIComponent(`${lawName} ${joDisplay}`.trim())
  const articlePath = joDisplay ? `/${encodeURIComponent(joDisplay)}` : ""
  return {
    ...base,
    articleSearch: `https://www.law.go.kr/lsSc.do?query=${query}`,
    articleDirect: `https://www.law.go.kr/법령/${encodeURIComponent(String(lawName || "").trim())}${articlePath}`
  }
}

function extractJoFromText(text) {
  const m = String(text || "").match(/제\s*(\d+)조(?:의\s*(\d+))?/)
  if (!m) return null
  return m[2] ? `제${Number(m[1])}조의${Number(m[2])}` : `제${Number(m[1])}조`
}

function buildDelegatedLinks(articleBlock, lawName, currentJo, includeFallback = false) {
  const delegated = []
  const normalizedLawName = String(lawName || "").trim()
  if (!normalizedLawName) return delegated

  const execSnippet = articleBlock.match(/시행령[^。\n]*제\s*\d+조(?:의\s*\d+)?/)?.[0] || ""
  const ruleSnippet = articleBlock.match(/시행규칙[^。\n]*제\s*\d+조(?:의\s*\d+)?/)?.[0] || ""
  const execJo = extractJoFromText(execSnippet) || currentJo
  const ruleJo = extractJoFromText(ruleSnippet) || currentJo
  const isAlreadyDelegatedLaw = /(시행령|시행규칙)\s*$/.test(normalizedLawName)
  const shouldUseFallback = includeFallback && !isAlreadyDelegatedLaw

  if (shouldUseFallback || /대통령령으로\s*정하는\s*바/.test(articleBlock) || /시행령/.test(articleBlock)) {
    const execLawName = `${normalizedLawName} 시행령`
    delegated.push({
      kind: "시행령",
      lawName: execLawName,
      jo: execJo,
      ...buildArticleLinks(execLawName, execJo)
    })
  }

  if (shouldUseFallback || /(총리령|부령|교육부령)으로\s*정하는\s*바/.test(articleBlock) || /시행규칙/.test(articleBlock)) {
    const ruleLawName = `${normalizedLawName} 시행규칙`
    delegated.push({
      kind: "시행규칙",
      lawName: ruleLawName,
      jo: ruleJo,
      ...buildArticleLinks(ruleLawName, ruleJo)
    })
  }

  return delegated
}

function buildFollowupQuestion(articleBlock, delegatedLinks = []) {
  const exec = delegatedLinks.find((d) => d.kind === "시행령")
  const rule = delegatedLinks.find((d) => d.kind === "시행규칙")

  if (exec?.jo) {
    return `추천 질문: "이 조문에서 말하는 기준을 ${exec.lawName} ${exec.jo} 기준으로 풀어서 설명해줘."`
  }
  if (exec) {
    return `추천 질문: "이 조문에서 말하는 기준을 ${exec.lawName} 기준으로 구체적으로 설명해줘."`
  }
  if (rule?.jo) {
    return `추천 질문: "실무 제출서류·절차를 ${rule.lawName} ${rule.jo} 기준으로 정리해줘."`
  }
  if (rule) {
    return `추천 질문: "실무 제출서류·절차를 ${rule.lawName} 기준으로 정리해줘."`
  }
  if (/처벌|과태료|제재/.test(articleBlock)) {
    return `추천 질문: "이 조문 위반 시 처분·과태료·형사처벌 기준을 표로 정리해줘."`
  }
  if (/신고|허가|등록|승인/.test(articleBlock)) {
    return `추천 질문: "이 조문 기준으로 신청요건·구비서류·처리기한을 체크리스트로 만들어줘."`
  }
  return `추천 질문: "이 조문을 민원 회신 문장으로 5줄 이내로 작성해줘."`
}

function buildLinkSummarySection(baseLinks, delegatedLinks = [], relatedSections = []) {
  const lines = ["", "---", "", "**원문 링크 (국가법령정보센터)**", ""]
  if (baseLinks?.articleDirect) {
    lines.push(`- [원문 조문 바로가기](${baseLinks.articleDirect})`)
  }
  for (const d of delegatedLinks) {
    const fetched = relatedSections.find(s => s.kind === d.kind);
    if (!fetched && d?.articleDirect) {
      lines.push(`- [${d.kind} 바로가기](${d.articleDirect})`)
    }
  }
  for (const s of relatedSections) {
    if (s?.link) {
      lines.push(`- [${s.kind} 원문 바로가기](${s.link})`)
    }
  }
  return lines.join("\n").trim()
}

function buildQuickLinks(baseLinks, delegatedLinks = [], relatedSections = []) {
  const out = []
  if (baseLinks?.articleDirect) out.push({ kind: "원문 조문", url: baseLinks.articleDirect })
  for (const d of delegatedLinks) {
    if (d?.articleDirect) out.push({ kind: d.kind, url: d.articleDirect })
  }
  for (const s of relatedSections) {
    if (s?.link) out.push({ kind: `관련 ${s.kind}`, url: s.link })
  }
  const seen = new Set()
  return out.filter((r) => {
    const key = `${r.kind}|${r.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildBriefExplanation(articleBlock) {
  const text = String(articleBlock || "").replace(/\r\n/g, "\n").trim()
  if (!text) return ""

  const firstSentence = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^제\s*\d+조/.test(line) && !/^\d+\.\s+/.test(line) && !/^[①-⑩]/.test(line))

  if (!firstSentence) return ""

  return `설명: ${emphasizeKeyPhrases(firstSentence)}`
}

function parseJoAndClause(joInput) {
  const raw = String(joInput || "").trim()
  if (!raw) return { joForLookup: undefined, clauseNo: null }

  const clauseMatch = raw.match(/(\d+)\s*항/)
  const clauseNo = clauseMatch ? Number(clauseMatch[1]) : null
  const joForLookup = raw.replace(/\s*\d+\s*항.*/, "").trim() || raw
  return { joForLookup, clauseNo }
}

function extractClauseBlock(articleBlock, clauseNo) {
  if (!clauseNo || clauseNo < 1) return articleBlock
  const markers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"]
  const marker = markers[clauseNo - 1]
  if (!marker) return articleBlock

  const text = String(articleBlock || "")
  const start = text.indexOf(marker)
  if (start < 0) return articleBlock

  let end = text.length
  for (const m of markers) {
    if (m === marker) continue
    const idx = text.indexOf(m, start + marker.length)
    if (idx >= 0 && idx < end) end = idx
  }
  return text.slice(start, end).trim()
}

function emphasizeKeyPhrases(input) {
  let out = String(input || "")
  const patterns = [
    /대통령령으로\s*정하는\s*바/g,
    /(총리령|부령|교육부령)으로\s*정하는\s*바/g,
    /시행령/g,
    /시행규칙/g,
    /하여야\s*한다/g,
    /할\s*수\s*있다/g,
    /해서는\s*안\s*된다/g,
    /초과하여\s*징수/g,
    /게시해야\s*한다/g,
    /영수증을\s*발급하여야\s*한다/g
  ]
  for (const p of patterns) {
    out = out.replace(p, (m) => `**${m}**`)
  }
  return out
}

function summarizeArticleBlock(articleBlock) {
  const text = String(articleBlock || "").replace(/\r\n/g, "\n").trim()
  const firstSentence = (text.match(/(.+?[다\.])(?:\n|$)/)?.[1] || "").trim()
  const numbered = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+/.test(l))
    .map((l) => l.replace(/^\d+\.\s+/, ""))

  const lines = []
  if (firstSentence) lines.push(`핵심: ${firstSentence}`)
  if (numbered.length > 0) {
    lines.push(`적용 범위: ${numbered.join(", ")}`)
  }
  return lines.join("\n")
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
  const articleBlockRaw = text.slice(articleStart, articleEnd).trim();
  const articleBlock = options?.clauseNo ? extractClauseBlock(articleBlockRaw, options.clauseNo) : articleBlockRaw;

  const joDisplay = (headerMatch[0].match(/제\s*\d+조(?:의\s*\d+)?/)?.[0] || meta.joDisplay || "해당 조문")
    .replace(/\s+/g, "");

  const delegatedLinks = buildDelegatedLinks(articleBlock, lawName, joDisplay, true);
  const readableArticle = emphasizeKeyPhrases(
    articleBlock
      .replace(/\n(\d+\.\s+)/g, "\n\n$1")
      .replace(/\n(①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩)/g, "\n\n$1")
  );
  const briefExplanation = buildBriefExplanation(articleBlockRaw);

  let out = `${lawName} ${joDisplay} 조문입니다.\n\n---\n\n${readableArticle}`;
  if (options?.clauseNo) {
    out = `${lawName} ${joDisplay} ${options.clauseNo}항 조문입니다.\n\n---\n\n${readableArticle}`;
  }

  if (briefExplanation) {
    out += `\n\n---\n\n${briefExplanation}`;
  }

  return out.trim();
}

function buildLawSourceLinks(lawName) {
  const name = String(lawName || "").trim();
  const encoded = encodeURIComponent(name);
  return {
    search: `https://www.law.go.kr/lsSc.do?query=${encoded}`,
    direct: `https://www.law.go.kr/법령/${encoded}`
  };
}

function classifyCivilQuestion(question) {
  const q = String(question || "");
  if (/학원|교습|과외/.test(q)) return "학원·교육 관련";
  if (/계약|입찰|낙찰|용역/.test(q)) return "계약·조달 관련";
  if (/아동|청소년|복지/.test(q)) return "복지 관련";
  if (/토지|건물|부동산/.test(q)) return "부동산·재산 관련";
  if (/처벌|과태료|형사/.test(q)) return "행정처분·형사 관련";
  return "일반 행정";
}

function inferJurisdictionAndPriority(lawResults) {
  const ministries = [...new Set((lawResults || []).map(r => r.ministryName).filter(Boolean))];
  return {
    guidance: ministries.length > 0 ? `소관부처: ${ministries.join(", ")}` : "관할 미확인",
    ministries
  };
}

function selectInternalRules(internalRules, question, limit = 3) {
  if (!internalRules || internalRules.length === 0) return [];
  const rules = internalRules.map(r => {
    if (typeof r === "string") return { title: "", content: r, excerpt: r.slice(0, 100) };
    return { title: r.title || "", content: r.content || "", excerpt: (r.content || "").slice(0, 100) };
  });
  return rules.slice(0, limit);
}

function collectLawNodes(parsed) {
  const root = parsed?.LawHstInfo || parsed?.lawHstInfo || parsed;
  const items = root?.law || root?.Law || [];
  return Array.isArray(items) ? items : (items ? [items] : []);
}

function pickByIncludes(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (keys.some(s => String(k).includes(s))) {
      const str = String(v ?? "").trim();
      return str || undefined;
    }
  }
  return undefined;
}

function parseRecentYears({ recentYears, periodText } = {}) {
  if (Number.isFinite(Number(recentYears)) && Number(recentYears) > 0) return Number(recentYears);
  const m = String(periodText || "").match(/(\d+)\s*년/);
  if (m) return Number(m[1]);
  if (/최근/.test(String(periodText || ""))) return 3;
  return null;
}

function ymdYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatYmdDot(ymd) {
  const s = String(ymd || "").replace(/\D/g, "");
  if (s.length >= 8) return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
  return ymd ? String(ymd) : "";
}

function formatJoDisplay(joNo) {
  const s = String(joNo || "");
  const m = s.match(/(\d+)(?:[_\-](\d+))?/);
  if (!m) return s;
  return m[2] ? `제${Number(m[1])}조의${Number(m[2])}` : `제${Number(m[1])}조`;
}

function joMatches(joNo, joDisplay, joFilter) {
  if (!joFilter) return true;
  const f = String(joFilter).replace(/\s/g, "");
  const d = String(joDisplay || "").replace(/\s/g, "");
  const n = String(joNo || "").replace(/\s/g, "");
  return d === f || n === f || d.startsWith(f) || f.startsWith(d);
}

function toYmd(dateStr) {
  return String(dateStr || "").replace(/\D/g, "").slice(0, 8);
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
        error: "異쒖쿂媛 ?뺤씤?섏? ?딆븘 ?붿빟???앹꽦?섏? ?딆븯?듬땲??",
        sourceRequired: true
      });
    }

    // Keep response structured and concise (disable long free-form priority)
    const summary = [
      `${category} ?좏삎?쇰줈 遺꾨쪟?섏뿀?듬땲??`,
      `${jurisdiction.guidance}`,
      `湲곗??? ${asOfDate}`
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

// ???? ?癒?뒄甕곕벚??????????????????????????????????????????????????????????????????????????????????????????????
app.post("/law/ordinance/search", async (req, res) => {
  try {
    const { query, display } = req.body;
    if (!query) return res.status(400).json({ error: "query揶쎛 ?袁⑹뒄??몃빍??" });
    const result = await searchOrdinance(apiClient, { query, display: display ?? 20 });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/law/ordinance/text", async (req, res) => {
  try {
    const { ordinSeq, jo } = req.body;
    if (!ordinSeq) return res.status(400).json({ error: "ordinSeq揶쎛 ?袁⑹뒄??몃빍??" });
    const result = await getOrdinance(apiClient, { ordinSeq: String(ordinSeq), jo });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ???? ?癒? ??????????????????????????????????????????????????????????????????????????????????????????????????
app.post("/law/precedent/search", async (req, res) => {
  try {
    const { query, court, display, page } = req.body;
    if (!query) return res.status(400).json({ error: "query揶쎛 ?袁⑹뒄??몃빍??" });
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
    if (!id) return res.status(400).json({ error: "id(?癒???곗졃甕곕뜇??揶쎛 ?袁⑹뒄??몃빍??" });
    const result = await getPrecedentText(apiClient, { id: String(id) });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ???? 甕곕베議??怨좎겫 ??????????????????????????????????????????????????????????????????????????????????????????
app.post("/law/history", async (req, res) => {
  try {
    const { lawName, display } = req.body;
    if (!lawName) return res.status(400).json({ error: "lawName???袁⑹뒄??몃빍??" });
    const result = await searchHistoricalLaw(apiClient, {
      lawName,
      display: display ?? 50,
    });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ???? 癰귢쑵紐???뽯뻼 ??????????????????????????????????????????????????????????????????????????????????????????
app.post("/law/annex", async (req, res) => {
  try {
    const { lawName, knd, bylSeq, annexNo } = req.body;
    if (!lawName) return res.status(400).json({ error: "lawName???袁⑹뒄??몃빍??" });

    // ??ν뀧 甕곕베議딉쭗????⑤벊???袁⑷퍥筌???곴퐤
    // ?? "??덉뜚甕???쀫뻬域뱀뮇?? ??"??덉뜚????삘뵲夷??곸겫 獄??⑥눘?끾뤃癒?뮸???온??甕곕베履???쀫뻬域뱀뮇??
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
    } catch (_) { /* 野꺜????쎈솭 ???癒?삋 ??已??醫? */ }

    const result = await getAnnexes(apiClient, { lawName: resolvedName, knd, bylSeq, annexNo, apiKey: LAW_OC });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ???? 鈺곌퀡揆癰?揶쏆뮇????????????????????????????????????????????????????????????????????????????????
// lsJoHstInf API揶쎛 ??甕곕벚而??????? ?醫륁굨???袁⑥뵭???嚥?
// searchHistoricalLaw ??getHistoricalLaw 筌ｋ똻???곗쨮 ?????
app.post("/law/article-history", async (req, res) => {
  try {
    const { lawName, lawId, jo, fromRegDt, toRegDt, recentYears, periodText, limit } = req.body;
    if (!lawName && !lawId) return res.status(400).json({ error: "lawName ?먮뒗 lawId媛 ?꾩슂?⑸땲??" });

    let resolvedLawId = lawId ? String(lawId) : undefined;
    let resolvedLawName = lawName ? String(lawName) : undefined;
    if (!resolvedLawId && resolvedLawName) {
      const raw = await apiClient.searchLaw(resolvedLawName, LAW_OC);
      const parsedSearch = parseSearchLawXml(raw);
      const normalized = resolvedLawName.replace(/\s/g, "");
      const exact = parsedSearch.results.find((r) => (r.lawName || "").replace(/\s/g, "") === normalized);
      const pick = exact || parsedSearch.results[0];
      if (!pick?.lawId) {
        return res.json({ success: false, text: `'${resolvedLawName}' 踰뺣졊??李얠? 紐삵뻽?듬땲??` });
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
      return res.json({ success: false, text: "媛쒖젙 ?대젰???놁뒿?덈떎." });
    }

    const records = [];
    for (const lawNode of lawNodes) {
      const lawInfo = lawNode["\uBC95\uB839\uC815\uBCF4"] || lawNode.lawInfo || lawNode["LawInfo"] || {};
      const lawNameFromRow =
        pickByIncludes(lawInfo, ["\uBC95\uB839\uBA85\uD55C\uAE00", "\uBC95\uB839\uBA85", "lawName"]) ||
        String(resolvedLawName || "");
      const lawIdFromRow = pickByIncludes(lawInfo, ["\uBC95\uB839ID", "lawId", "ID"]) || String(resolvedLawId || "");
      const mst = pickByIncludes(lawInfo, ["\uBC95\uB839\uC77C\uB828\uBC88\uD638", "MST"]);
      const promulgationDate = pickByIncludes(lawInfo, ["\uACF5\uD3EC\uC77C\uC790", "promulgationDate"]);

      const joNodes = toArray(lawNode.jo || lawNode.JO || lawNode["\uC870"] || []);
      for (const joNode of joNodes) {
        const joNo = pickByIncludes(joNode, ["\uC870\uBB38\uBC88\uD638", "joNo", "JO"]);
        const joDisplay = formatJoDisplay(joNo);
        if (!joMatches(joNo, joDisplay, jo)) continue;

        const joRegDt = pickByIncludes(joNode, ["\uC870\uBB38\uAC1C\uC815\uC77C", "regDt", "\uAC1C\uC815\uC77C"]);
        const joEffDt = pickByIncludes(joNode, ["\uC870\uBB38\uC2DC\uD589\uC77C", "effDt", "\uC2DC\uD589\uC77C"]);
        const changeReason = pickByIncludes(joNode, ["\uBCC0\uACBD\uC0AC\uC720", "changeReason"]);

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
      return res.json({ success: false, text: "?붿껌??議고빆??媛쒖젙 ?대젰???놁뒿?덈떎." });
    }

    records.sort((a, b) => {
      const aDate = toYmd(a.joRegDt) || toYmd(a.promulgationDate) || "00000000";
      const bDate = toYmd(b.joRegDt) || toYmd(b.promulgationDate) || "00000000";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return String(b.mst || "").localeCompare(String(a.mst || ""));
    });

    const sliced = records.slice(0, pageLimit);
    const scopeText = effectiveFromRegDt
      ? `議고쉶湲곌컙: ${formatYmdDot(effectiveFromRegDt)} ~ ${effectiveToRegDt ? formatYmdDot(effectiveToRegDt) : "?꾩옱"}\n`
      : "議고쉶湲곌컙: ?꾩껜(理쒖떊??\n";

    let text = `${sliced[0].lawName || lawName || lawId} 議곕Ц 媛쒖젙?대젰 (理쒖떊??\n${scopeText}\n`;
    sliced.forEach((r, idx) => {
      text += `${idx + 1}. ${r.joDisplay}\n`;
      text += `   - 媛쒖젙?? ${formatYmdDot(r.joRegDt || r.promulgationDate || "") || "?뺣낫?놁쓬"}\n`;
      text += `   - ?쒗뻾?? ${formatYmdDot(r.joEffDt || "") || "?뺣낫?놁쓬"}\n`;
      if (r.changeReason) text += `   - 蹂寃쎌궗?? ${r.changeReason}\n`;
      if (r.lawId || r.mst) text += `   - lawId: ${r.lawId || "-"}, MST: ${r.mst || "-"}\n`;
      text += "\n";
    });

    if (records.length > sliced.length) {
      text += `... 珥?${records.length}嫄?以?${sliced.length}嫄??쒖떆\n`;
    }

    return res.json({ success: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/law/history/text", async (req, res) => {
  try {
    const { mst, jo } = req.body;
    if (!mst) return res.status(400).json({ error: "mst揶쎛 ?袁⑹뒄??몃빍??" });
    const result = await getHistoricalLaw(apiClient, { mst: String(mst), jo, apiKey: LAW_OC });
    mcpToResponse(res, result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
