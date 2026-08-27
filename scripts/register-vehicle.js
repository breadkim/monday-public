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
async function dumpClickables(page, label) {
  const info = await page.evaluate(() => {
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
  console.log(`===== [DOM DUMP: ${label}] (${info.length}) =====`);
  console.log(info.join("\n"));
  console.log("===== [/DOM DUMP] =====");
}

async function dumpInputs(page, label) {
  const info = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("input, select, textarea")).map((el) => {
      const rect = el.getBoundingClientRect();
      return `<${el.tagName.toLowerCase()} type="${el.type || ""}" name="${el.name || ""}" id="${el.id || ""}" placeholder="${el.placeholder || ""}" visible=${rect.width > 0 && rect.height > 0}>`;
    });
  });
  console.log(`===== [INPUT DUMP: ${label}] (${info.length}) =====`);
  console.log(info.join("\n"));
  console.log("===== [/INPUT DUMP] =====");
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

  // 화면 상단 삼선(햄버거) 메뉴 버튼 클릭 - 정확한 셀렉터를 몰라 여러 후보를 시도
  const menuOpened = await clickFirstMatch(page, [
    (p) => p.locator('button[aria-label*="메뉴"]'),
    (p) => p.locator('[class*="hamburger" i]'),
    (p) => p.locator('[class*="gnb" i] button'),
    (p) => p.locator('header button').first(),
    (p) => p.locator('nav button').first(),
    (p) => p.locator('img[alt*="메뉴"]'),
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
  await shot(page, "07-predicount-status-page");
}

async function registerVehicle(page) {
  await dumpClickables(page, "predicount-status-page");

  const registerClicked = await clickFirstMatch(page, [
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
  await shot(page, "09-register-form");
  await dumpInputs(page, "register-form");

  // 차량번호, 시작일, 종료일 입력 - 정확한 필드명을 몰라 placeholder/라벨 기반으로 우선 시도하고,
  // 실패 시 화면에 보이는 입력창을 순서대로(차량번호 -> 시작일 -> 종료일) 채우는 방식으로 폴백
  const vehicleInput = page
    .locator('input[placeholder*="차량"], input[name*="car" i], input[name*="vehicle" i]')
    .first();
  const startInput = page
    .locator('input[placeholder*="시작"], input[type="date"]')
    .first();
  const endInput = page
    .locator('input[placeholder*="종료"], input[type="date"]')
    .nth(1);

  if (await vehicleInput.count()) {
    await vehicleInput.fill(requireEnv("VEHICLE_NUMBER", VEHICLE_NUMBER));
  } else {
    const inputs = page.locator("input:visible");
    await inputs.nth(0).fill(requireEnv("VEHICLE_NUMBER", VEHICLE_NUMBER));
  }

  if (await startInput.count()) {
    await startInput.fill(requireEnv("START_DATE", START_DATE));
  } else {
    const inputs = page.locator("input:visible");
    await inputs.nth(1).fill(requireEnv("START_DATE", START_DATE));
  }

  if ((await endInput.count()) > 0) {
    await endInput.fill(requireEnv("END_DATE", END_DATE));
  } else {
    const inputs = page.locator("input:visible");
    await inputs.nth(2).fill(requireEnv("END_DATE", END_DATE));
  }

  await shot(page, "10-form-filled");

  const submitted = await clickFirstMatch(page, [
    (p) => p.getByRole("button", { name: /등록|저장|확인/ }),
    (p) => p.locator('button:has-text("등록")'),
    (p) => p.locator('button:has-text("저장")'),
    (p) => p.locator('button:has-text("확인")'),
  ]);
  if (!submitted) {
    await shot(page, "11-submit-button-not-found");
    throw new Error(
      "등록 폼의 제출(등록/저장/확인) 버튼을 찾지 못했습니다. screenshots/11-submit-button-not-found.png 를 확인해주세요."
    );
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  await shot(page, "12-after-submit");
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
