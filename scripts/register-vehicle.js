// parkingweb.kr 사전할인등록(차량등록) 자동화 스크립트
//
// 실행 환경: GitHub Actions (workflow_dispatch)
// 필요한 값:
//   PARKINGWEB_USERNAME, PARKINGWEB_PASSWORD  -> GitHub Actions Secrets
//   VEHICLE_NUMBER, START_DATE, END_DATE      -> workflow_dispatch 입력값 (env로 전달)
//
// 주의: 이 스크립트는 실제 사이트 접근이 차단된 환경에서 작성되어, 정확한 HTML
// 구조(셀렉터)를 직접 확인하지 못한 채 사용자가 설명한 화면 흐름을 바탕으로
// 작성되었습니다. 최초 실행 시 실패하면 아래 각 STEP의 스크린샷
// (screenshots/ 디렉터리, Actions 아티팩트로 업로드됨)을 확인하고
// 셀렉터를 조정해야 할 수 있습니다.

const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://a16829.parkingweb.kr";
const SCREENSHOT_DIR = path.join(__dirname, "..", "screenshots");

const USERNAME = process.env.PARKINGWEB_USERNAME;
const PASSWORD = process.env.PARKINGWEB_PASSWORD;
const VEHICLE_NUMBER = (process.env.VEHICLE_NUMBER || "").replace(/\s+/g, "");
const START_DATE = process.env.START_DATE;
const END_DATE = process.env.END_DATE;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`필수 값이 없습니다: ${name}`);
  }
  return value;
}

async function shot(page, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`[screenshot] ${file}`);
}

// 스크린샷을 이 환경에서 직접 볼 수 없어, 클릭 가능한 요소들을 텍스트로 로그에 남겨
// 실제 페이지 구조를 job 로그만으로 파악하기 위한 진단 함수
// 내비게이션 도중 evaluate가 깨지는 경우를 대비해 한 번 재시도 후 실패해도 무시
async function safeEvaluate(page, fn, arg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      await page.waitForLoadState("load").catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  return null;
}

async function dumpClickables(page, label) {
  const info = await safeEvaluate(page, () => {
    const els = Array.from(
      document.querySelectorAll('button, a, [role="button"], [onclick], nav *, header *')
    );
    const seen = new Set();
    const out = [];
    for (const el of els) {
      const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const aria = el.getAttribute("aria-label") || "";
      const cls = (el.className || "").toString().slice(0, 60);
      const id = el.id || "";
      const tag = el.tagName.toLowerCase();
      if (!text && !aria && !cls && !id) continue;
      const key = `${tag}|${id}|${cls}|${text}|${aria}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`<${tag} id="${id}" class="${cls}" aria-label="${aria}"> ${text}`);
      if (out.length >= 60) break;
    }
    return out;
  });
  console.log(`===== [DOM DUMP: ${label}] (${info ? info.length : "unavailable"}) =====`);
  if (info) console.log(info.join("\n"));
  console.log("===== [/DOM DUMP] =====");
}

async function dumpInputs(page, label) {
  const info = await safeEvaluate(page, () => {
    return Array.from(document.querySelectorAll("input, select, textarea")).map((el) => {
      const rect = el.getBoundingClientRect();
      const onclick = el.getAttribute("onclick") || "";
      return `<${el.tagName.toLowerCase()} type="${el.type || ""}" name="${el.name || ""}" id="${el.id || ""}" placeholder="${el.placeholder || ""}" value="${el.value || ""}" class="${(el.className || "").toString().slice(0, 60)}" onclick="${onclick}" visible=${rect.width > 0 && rect.height > 0}>`;
    });
  });
  console.log(`===== [INPUT DUMP: ${label}] (${info ? info.length : "unavailable"}) =====`);
  if (info) console.log(info.join("\n"));
  console.log("===== [/INPUT DUMP] =====");
}

// 태그 종류에 상관없이(div/span 등) id/class/name/placeholder/text에 특정 키워드가
// 포함된 모든 요소를 찾아 로그로 남김 - 날짜(캘린더) 관련 요소가 button/a/input이
// 아닌 경우를 대비한 진단 함수
async function dumpByKeyword(page, label, keywords) {
  const info = await safeEvaluate(
    page,
    (keywords) => {
      const els = Array.from(document.querySelectorAll("*"));
      const out = [];
      for (const el of els) {
        const id = el.id || "";
        const cls = (el.className || "").toString();
        const name = el.getAttribute && (el.getAttribute("name") || "");
        const placeholder = el.getAttribute && (el.getAttribute("placeholder") || "");
        const text = (el.childElementCount === 0 ? el.textContent || "" : "").trim().slice(0, 30);
        const haystack = `${id} ${cls} ${name} ${placeholder} ${text}`.toLowerCase();
        if (keywords.some((k) => haystack.includes(k.toLowerCase()))) {
          const rect = el.getBoundingClientRect();
          out.push(
            `<${el.tagName.toLowerCase()} id="${id}" class="${cls.slice(0, 60)}" name="${name}" placeholder="${placeholder}"> text="${text}" visible=${rect.width > 0 && rect.height > 0}`
          );
        }
        if (out.length >= 80) break;
      }
      return out;
    },
    keywords
  );
  console.log(`===== [KEYWORD DUMP: ${label}] (${info ? info.length : "unavailable"}) =====`);
  if (info) console.log(info.join("\n"));
  console.log("===== [/KEYWORD DUMP] =====");
}

// 텍스트로 후보들을 순서대로 시도해 클릭 (사이트 구조를 정확히 몰라 여러 후보를 폴백으로 시도)
async function clickFirstMatch(page, candidates, timeout = 5000) {
  for (const locatorFn of candidates) {
    try {
      const locator = locatorFn(page);
      await locator.first().waitFor({ state: "visible", timeout });
      await locator.first().click();
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await shot(page, "01-home");

  // 비밀번호 입력창은 type=password 로 비교적 신뢰도 높게 찾을 수 있음
  const pwInput = page.locator('input[type="password"]').first();
  await pwInput.waitFor({ state: "visible", timeout: 15000 });

  // 아이디 입력창: password 입력창 바로 앞의 텍스트/전화 입력창으로 추정
  const idInput = page
    .locator('input[type="text"], input[type="tel"], input:not([type])')
    .first();
  await idInput.waitFor({ state: "visible", timeout: 15000 });

  await idInput.fill(requireEnv("PARKINGWEB_USERNAME", USERNAME));
  await pwInput.fill(requireEnv("PARKINGWEB_PASSWORD", PASSWORD));
  await shot(page, "02-login-filled");

  const clicked = await clickFirstMatch(page, [
    (p) => p.getByRole("button", { name: /로그인|login/i }),
    (p) => p.locator('button:has-text("로그인")'),
    (p) => p.locator('input[type="submit"][value*="로그인"]'),
    (p) => p.locator('a:has-text("로그인")'),
  ]);
  if (!clicked) {
    // 마지막 폴백: password 입력창에서 Enter
    await pwInput.press("Enter");
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await shot(page, "03-after-login");
}

async function openPreDiscountMenu(page) {
  await dumpClickables(page, "after-login");

  // jQuery Mobile 사이트: 삼선 메뉴는 a.slide-menu-open (class에 ui-icon-flat-menu 포함)
  const menuOpened = await clickFirstMatch(page, [
    (p) => p.locator("a.slide-menu-open"),
    (p) => p.locator(".ui-icon-flat-menu"),
    (p) => p.locator('button[aria-label*="메뉴"]'),
    (p) => p.locator('[class*="hamburger" i]'),
  ]);
  if (!menuOpened) {
    await shot(page, "04-menu-not-found");
    throw new Error(
      "삼선(햄버거) 메뉴 버튼을 찾지 못했습니다. screenshots/04-menu-not-found.png 를 확인하고 셀렉터를 조정해주세요."
    );
  }
  await shot(page, "05-menu-open");
  await dumpClickables(page, "menu-open");

  const menuClicked = await clickFirstMatch(page, [
    (p) => p.getByText("사전할인등록현황", { exact: false }),
    (p) => p.locator('a:has-text("사전할인등록현황")'),
  ]);
  if (!menuClicked) {
    await shot(page, "06-predicount-menu-not-found");
    throw new Error(
      "'사전할인등록현황' 메뉴를 찾지 못했습니다. screenshots/06-predicount-menu-not-found.png 를 확인해주세요."
    );
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);
  await shot(page, "07-predicount-status-page");
}

async function registerVehicle(page) {
  await dumpClickables(page, "predicount-status-page");

  // 사용자 확인: 목록 화면의 빨간 "등록" 버튼을 누르면 [서초로이움지젤] 제목의
  // 등록 모달(차량번호/시작일/종료일/할인/비고 + "사전차량등록" 버튼)이 뜸
  const registerClicked = await clickFirstMatch(page, [
    (p) => p.locator("#btnSearch.ui-btn-d"),
    (p) => p.getByRole("button", { name: /^등록$/ }),
    (p) => p.locator('button:has-text("등록")'),
    (p) => p.locator('a:has-text("등록")'),
  ]);
  if (!registerClicked) {
    await shot(page, "08-register-button-not-found");
    throw new Error(
      "'등록' 버튼을 찾지 못했습니다. screenshots/08-register-button-not-found.png 를 확인해주세요."
    );
  }

  // 모달이 뜨는지 "사전차량등록" 제출 버튼 텍스트로 확인 (배경 목록은 그대로 DOM에 남아있을 수 있음)
  const modalOpened = await page
    .getByText("사전차량등록", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  await shot(page, "09-register-form");
  await dumpInputs(page, "register-form");
  await dumpClickables(page, "register-form");
  await dumpByKeyword(page, "register-form", [
    "date",
    "calendar",
    "start",
    "end",
    "시작",
    "종료",
    "cal",
    "day",
    "picker",
    "term",
    "period",
  ]);

  if (!modalOpened) {
    throw new Error(
      "'등록' 클릭 후 등록 모달('사전차량등록' 텍스트)이 뜨지 않았습니다. 위 진단 로그를 확인하세요."
    );
  }

  // 모달까지는 확인했으나 시작일/종료일 캘린더 위젯의 정확한 구조는 아직 확인 전이라,
  // 안전을 위해 여기서 멈추고 위 진단 로그를 바탕으로 다음 커밋에서 마저 구현합니다.
  throw new Error(
    "등록 모달은 확인했습니다. 시작일/종료일 캘린더 구조 확인을 위해 여기서 멈춥니다. 위 DOM/INPUT DUMP 로그를 확인하세요."
  );
}

async function checkResult(page) {
  const checked = await clickFirstMatch(page, [
    (p) => p.getByRole("button", { name: /^조회$/ }),
    (p) => p.locator('button:has-text("조회")'),
    (p) => p.locator('a:has-text("조회")'),
  ]);
  if (checked) {
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await shot(page, "13-check-result");

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return bodyText;
}

async function main() {
  requireEnv("PARKINGWEB_USERNAME", USERNAME);
  requireEnv("PARKINGWEB_PASSWORD", PASSWORD);
  requireEnv("VEHICLE_NUMBER", VEHICLE_NUMBER);
  requireEnv("START_DATE", START_DATE);
  requireEnv("END_DATE", END_DATE);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    locale: "ko-KR",
  });
  const page = await context.newPage();

  try {
    await login(page);
    await openPreDiscountMenu(page);
    await registerVehicle(page);
    const resultText = await checkResult(page);

    console.log("===== 조회 결과 (페이지 텍스트) =====");
    console.log(resultText);
    console.log("=====================================");

    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
      fs.appendFileSync(
        summaryFile,
        `## 사전할인등록 결과\n\n- 차량번호: ${VEHICLE_NUMBER}\n- 기간: ${START_DATE} ~ ${END_DATE}\n\n\`\`\`\n${resultText}\n\`\`\`\n`
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
