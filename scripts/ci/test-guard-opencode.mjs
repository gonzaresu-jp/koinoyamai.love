// opencode 用アダプタ（.opencode/plugins/agent-guard.js）の判定テスト。
// scripts/ci/test-guard.sh から node で呼ばれる（node が無い環境では test-guard.sh 側で飛ばす）。
//   deny … throw する（理由に [guard] が入る）
//   ask  … throw する（opencode では deny に倒れる。理由に ask の旨が入る）
//   allow … throw しない
// プラグインは ESM 形式（export）で書かれているが、このリポジトリには package.json が無く
// node が .js を ESM として読めないため、一時ディレクトリに .mjs として複製してから読み込む
// （プラグインは相対 import を持たないので、複製しても挙動は変わらない）。
import { copyFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const tmp = mkdtempSync(join(tmpdir(), "test-guard-opencode-"))
const pluginFile = join(tmp, "agent-guard.mjs")
copyFileSync(join(root, ".opencode", "plugins", "agent-guard.js"), pluginFile)

let mod
try {
  mod = await import(pluginFile)
} catch (e) {
  console.error(`  NG: opencode: プラグインを読み込めない: ${e.message}`)
  process.exit(1)
}
const hooks = await mod.AgentGuardPlugin({ directory: root, worktree: root })
const before = hooks["tool.execute.before"]
if (typeof before !== "function") {
  console.error("  NG: opencode: tool.execute.before が登録されていない")
  process.exit(1)
}

let fail = 0
let n = 0
const ng = (msg) => { console.error(`  NG: ${msg}`); fail = 1 }

async function expectOpencode(want, command, tool = "bash", args = undefined, hook = before) {
  n += 1
  const a = args ?? { command }
  let thrown = null
  try {
    await hook({ tool, sessionID: "test", callID: "test" }, { args: a })
  } catch (e) {
    thrown = e
  }
  if (want === "allow") {
    if (thrown) ng(`opencode: 期待 allow / 実際 deny: ${command} (${thrown.message})`)
    return
  }
  if (!thrown) { ng(`opencode: 期待 ${want} / 実際 allow: ${command}`); return }
  if (!thrown.message.includes("[guard]")) ng(`opencode: 理由が返らない: ${command}`)
  if (want === "ask" && !thrown.message.includes("ask")) ng(`opencode: ask の旨が理由に入らない: ${command}`)
}

await expectOpencode("deny", "git push --no-verify origin agent/x")
await expectOpencode("deny", "git push origin main")
await expectOpencode("deny", "git -c core.hooksPath=/dev/null push origin agent/x")
await expectOpencode("ask", "git push --force origin agent/x")
await expectOpencode("ask", "cat .env")
await expectOpencode("ask", "gh pr merge 12 --squash")
await expectOpencode("allow", "git push origin agent/x")
await expectOpencode("allow", "npm test")
await expectOpencode("deny", "git push \\\norigin main")
// bash 以外のツールは対象外（対象外の引数でも素通しする）
await expectOpencode("allow", "", "read", { filePath: ".env" })
// 空コマンドは素通し
await expectOpencode("allow", "")
// サブディレクトリから起動した場合も、核は worktree ルート基準で解決される
// （directory だけを基準にすると核を見失い、全コマンドが止まってしまう）
const subHooks = await mod.AgentGuardPlugin({ directory: join(root, "scripts"), worktree: root })
await expectOpencode("allow", "npm test", "bash", undefined, subHooks["tool.execute.before"])
await expectOpencode("deny", "git push origin main", "bash", undefined, subHooks["tool.execute.before"])

if (fail) { console.error("[test-guard-opencode] 失敗"); process.exit(1) }
console.log(`[test-guard-opencode] OK（${n} 件）`)
