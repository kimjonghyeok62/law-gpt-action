/**
 * get_article_history Tool - 일자별 조문 개정 이력 조회
 */
import { z } from "zod";
import { DOMParser } from "@xmldom/xmldom";
import { truncateResponse } from "../lib/schemas.js";
import { formatToolError } from "../lib/errors.js";
/**
 * JO 코드를 읽기 쉬운 형식으로 변환
 * 예: 003800 → 제38조, 001002 → 제10조의2
 */
function formatJoCode(joCode) {
    if (!joCode || joCode.length !== 6)
        return joCode;
    const articleNum = parseInt(joCode.substring(0, 4), 10);
    const branchNum = parseInt(joCode.substring(4, 6), 10);
    if (branchNum === 0) {
        return `제${articleNum}조`;
    }
    else {
        return `제${articleNum}조의${branchNum}`;
    }
}
/**
 * 조문번호 텍스트 → 6자리 API 코드 변환
 * 예: "제5조" → "000500", "제4조의2" → "000402", "000500" → "000500"
 */
function joTextToCode(joText) {
    if (!joText) return joText;
    if (/^\d{6}$/.test(joText)) return joText; // already 6-digit
    const match = joText.match(/제?(\d+)조?(?:의(\d+))?/);
    if (!match) return joText;
    const articleNum = parseInt(match[1], 10);
    const branchNum = match[2] ? parseInt(match[2], 10) : 0;
    return String(articleNum).padStart(4, '0') + String(branchNum).padStart(2, '0');
}
export const ArticleHistorySchema = z.object({
    lawId: z.string().optional().describe("법령ID (예: '003440'). search_law 결과의 법령ID 사용. lawName과 함께 사용 불가"),
    lawName: z.string().optional().describe("법령명 (예: '공정거래법 시행령'). 법령명으로 검색 후 자동으로 법령ID를 찾음"),
    jo: z.string().optional().describe("조문번호 (예: '제38조', 선택)"),
    regDt: z.string().regex(/^\d{8}$/, "YYYYMMDD 형식").optional().describe("조문 개정일 (YYYYMMDD, 선택)"),
    fromRegDt: z.string().regex(/^\d{8}$/, "YYYYMMDD 형식").optional().describe("조회기간 시작일 (YYYYMMDD, 예: '20240101')"),
    toRegDt: z.string().regex(/^\d{8}$/, "YYYYMMDD 형식").optional().describe("조회기간 종료일 (YYYYMMDD, 예: '20241231')"),
    org: z.string().optional().describe("소관부처코드 (선택)"),
    page: z.number().optional().default(1).describe("페이지 번호 (기본값: 1)"),
    apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달")
}).refine(data => data.lawId || data.lawName, { message: "lawId 또는 lawName 중 하나는 필수입니다" });
export async function getArticleHistory(apiClient, input) {
    try {
        let lawId = input.lawId;
        // lawName이 제공된 경우 먼저 법령 검색하여 lawId 찾기
        if (input.lawName && !lawId) {
            const searchResult = await apiClient.searchLaw(input.lawName, input.apiKey);
            // 검색 결과에서 모든 법령ID + 법령명 쌍 추출
            const lawEntries = [];
            const entryPattern = /<법령명한글>([^<]+)<\/법령명한글>[\s\S]*?<법령ID>(\d+)<\/법령ID>/g;
            let m;
            while ((m = entryPattern.exec(searchResult)) !== null) {
                lawEntries.push({ name: m[1].trim(), id: m[2] });
            }
            if (lawEntries.length === 0) {
                // fallback: 첫 번째 법령ID
                const fallback = searchResult.match(/<법령ID>(\d+)<\/법령ID>/);
                if (fallback) lawEntries.push({ name: input.lawName, id: fallback[1] });
            }
            if (lawEntries.length === 0) {
                return {
                    content: [{
                            type: "text",
                            text: `법령 '${input.lawName}'을(를) 찾을 수 없습니다. 법령명을 확인하거나 search_law로 먼저 검색해주세요.`
                        }],
                    isError: true
                };
            }
            // 검색어와 정확히 일치하는 법령 우선, 없으면 첫 번째
            const normalizedQuery = input.lawName.replace(/\s/g, '');
            const exact = lawEntries.find(e => e.name.replace(/\s/g, '') === normalizedQuery);
            lawId = (exact || lawEntries[0]).id;
        }
        // jo → 6자리 코드 변환 (API 요구 형식)
        const joCode = input.jo ? joTextToCode(input.jo) : undefined;
        const xmlText = await apiClient.getArticleHistory({ ...input, lawId, jo: joCode, apiKey: input.apiKey });
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, "text/xml");
        const totalCnt = doc.getElementsByTagName("totalCnt")[0]?.textContent || "0";
        const laws = doc.getElementsByTagName("law");
        if (laws.length === 0) {
            return {
                content: [{
                        type: "text",
                        text: "조문 개정 이력이 없습니다."
                    }]
            };
        }
        let resultText = `조문 개정 이력 (총 ${totalCnt}건):\n\n`;
        let itemNum = 0;
        for (let i = 0; i < laws.length; i++) {
            const law = laws[i];
            // 법령정보 추출
            const lawInfo = law.getElementsByTagName("법령정보")[0];
            const lawName = lawInfo?.getElementsByTagName("법령명한글")[0]?.textContent || "알 수 없음";
            const lawId = lawInfo?.getElementsByTagName("법령ID")[0]?.textContent || "";
            const mst = lawInfo?.getElementsByTagName("법령일련번호")[0]?.textContent || "";
            const promDate = lawInfo?.getElementsByTagName("공포일자")[0]?.textContent || "";
            const changeType = lawInfo?.getElementsByTagName("제개정구분명")[0]?.textContent || "";
            const effDate = lawInfo?.getElementsByTagName("시행일자")[0]?.textContent || "";
            // 조문정보 추출
            const joInfos = law.getElementsByTagName("jo");
            for (let j = 0; j < joInfos.length; j++) {
                itemNum++;
                const jo = joInfos[j];
                const joNo = jo.getElementsByTagName("조문번호")[0]?.textContent || "";
                const changeReason = jo.getElementsByTagName("변경사유")[0]?.textContent || "";
                const joRegDt = jo.getElementsByTagName("조문개정일")[0]?.textContent || "";
                const joEffDt = jo.getElementsByTagName("조문시행일")[0]?.textContent || "";
                // 조문번호를 읽기 쉬운 형식으로 변환 (예: 003800 → 제38조)
                const joDisplay = formatJoCode(joNo);
                resultText += `${itemNum}. ${lawName} ${joDisplay}\n`;
                resultText += `   - 법령ID: ${lawId}, MST: ${mst}\n`;
                resultText += `   - 개정구분: ${changeType}\n`;
                resultText += `   - 변경사유: ${changeReason}\n`;
                resultText += `   - 공포일: ${promDate}, 조문개정일: ${joRegDt}\n`;
                resultText += `   - 시행일: ${effDate}, 조문시행일: ${joEffDt}\n\n`;
            }
        }
        // 조문이 하나도 없는 경우 (법령정보만 있는 경우)
        if (itemNum === 0) {
            resultText = "조문 개정 이력이 없습니다.";
        }
        return {
            content: [{
                    type: "text",
                    text: truncateResponse(resultText)
                }]
        };
    }
    catch (error) {
        return formatToolError(error, "get_article_history");
    }
}
