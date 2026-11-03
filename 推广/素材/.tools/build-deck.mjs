/**
 * 用**产品自己的 PPT 生成链路**把大纲渲染成 .pptx（ppt-master + B站蓝色模板）。
 *
 * 用户口径：「PPT 应该用 PPT Master，用 B 站蓝色模版」。产品里这条链路是
 *   `renderPptDeck`（@scene/infra 按七种版式画 SVG，白底 + #0D47A1 主色的 B 站蓝色令牌，
 *   1280×720）→ `writePptSvgs` 落到 `<项目>/svg_output/`
 *   → ppt-master `finalize_svg.py <项目> --only embed-icons fix-rounded`（嵌真图标）
 *   → ppt-master `svg_to_pptx.py <项目> -o <out> --no-compat -f ppt169`（转 pptx，文字可编辑）。
 *
 * 与 `apps/server/src/ppt-export.ts` 走的是同一套脚本、同一串参数，只是大纲不由模型现生成，
 * 而是取自 `产品介绍-大纲.json`（这份 demo 素材的内容是固定的，不该每次重掷骰子）。
 *
 * 两道门禁都跑，只报告不阻断：`checkPptOutlineQuality`（大纲八条）+ `checkPptDeck`（版面）。
 *
 * 用法：
 *   node build-deck.mjs            只校验与渲染 SVG，不转 pptx
 *   node build-deck.mjs --emit     再跑 ppt-master 产出 .pptx
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkPptOutlineQuality } from "../../../packages/domain/dist/ppt-outline.js";
import { checkPptDeck } from "../../../packages/infra/dist/ppt-quality.js";
import { renderPptDeck, writePptSvgs } from "../../../packages/infra/dist/ppt-svg.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "demo资料");
const SKILL = process.env.PPT_MASTER_DIR ?? join(homedir(), ".dsh", "skills", "ppt-master");
const SCENARIO_NAME = "云枢智控 产品介绍";

const outline = JSON.parse(readFileSync(join(dir, "产品介绍-大纲.json"), "utf8"));
// 「正文」= 白皮书：数字只能来自这里，PPT 不得自己造数
const body = readFileSync(join(dir, "云枢智控-产品与能力白皮书.md"), "utf8");

console.log(`大纲 ${outline.pages.length} 页｜版式：${outline.pages.map((p) => p.layout).join(" → ")}`);

const outlineIssues = checkPptOutlineQuality(outline, body);
console.log(`\n【大纲质量】问题 ${outlineIssues.length} 处`);
for (const i of outlineIssues) console.log(`  第${i.page}页 [${i.code}] ${i.detail}`);

const pages = renderPptDeck(outline, { scenarioName: SCENARIO_NAME });
const deck = checkPptDeck(pages.map((p) => p.svg));
console.log(`\n【版面门禁】问题 ${deck.length} 处`);
for (const i of deck) console.log(`  第${i.page}页 [${i.code}] ${i.detail}`);

if (!process.argv.includes("--emit")) {
  console.log("\n（只校验，未产出 pptx；加 --emit 才会转档）");
  process.exit(0);
}

// ── 转档：与 apps/server/src/ppt-export.ts 同一串参数 ──────────────────
// 产物目录固定下来（不建在 tmpdir 里），这样收尾后的 SVG 还能复查与截图
const projectDir = process.env.DECK_BUILD_DIR ?? join(dir, ".deck-build");
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
writePptSvgs(projectDir, pages);
// 页脚品牌串：产品的导出器把它硬编码成「场景通 · <场景名>」（apps/server 的交付物场景里
// 这是对的——导出的解决方案确实是场景通生成的）。但这份 PPT 是**演示世界里虚构厂商自己的
// 产品介绍**，是喂给场景通的输入材料，印上工具名会让虚构设定穿帮。所以只在生成这份 demo 素材时
// 把页脚前缀摘掉，页面其余部分一字不动。这是唯一一处对产品渲染结果的改写，特此标明。
const FOOTER_PREFIX = "场景通 · ";
let touched = 0;
for (const f of readdirSync(join(projectDir, "svg_output"))) {
  const fp = join(projectDir, "svg_output", f);
  const svg = readFileSync(fp, "utf8");
  const fixed = svg.replace(/(<g id="footer">[\s\S]*?<\/g>)/, (g) =>
    g.includes(FOOTER_PREFIX) ? g.split(FOOTER_PREFIX).join("") : g,
  );
  if (fixed !== svg) { writeFileSync(fp, fixed); touched += 1; }
}
console.log(`→ 页脚品牌串已摘除（${touched}/${pages.length} 页）`);
console.log(`\n→ SVG 已写到 ${projectDir}/svg_output/（${pages.length} 页）`);

const py = await pickPython();
if (py === null) {
  console.error("❌ 没有 ≥3.10 的 python3，无法转档");
  process.exit(1);
}
const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

const finalize = join(SKILL, "scripts", "finalize_svg.py");
if (existsSync(finalize)) {
  await run(py, [finalize, projectDir, "--only", "embed-icons", "fix-rounded"], { env, maxBuffer: 8 << 20 });
  console.log("→ finalize_svg.py 完成（图标已嵌入）");
} else {
  console.log("⚠ 技能里没有 finalize_svg.py，跳过图标嵌入");
}

const out = join(dir, "云枢智控-产品介绍.pptx");
const convert = join(SKILL, "scripts", "svg_to_pptx.py");
await run(py, [convert, projectDir, "-o", out, "--no-compat", "-f", "ppt169"], { env, maxBuffer: 8 << 20 });
console.log(`✅ 写出 ${out}`);
console.log(`   SVG 成品留在 ${projectDir}/svg_final/ 供复查`);

async function pickPython() {
  const cands = [
    ...(process.env.PPT_PYTHON ? [process.env.PPT_PYTHON] : []),
    "python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ];
  for (const c of cands) {
    try {
      const { stdout } = await run(c, ["-c", "import sys; print(sys.version_info >= (3, 10))"], { timeout: 10_000 });
      if (String(stdout).trim() === "True") return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}
