// opencode 用アダプタ（プラグイン）: tool.execute.before で bash ツールのコマンドを取り出し、
// 核（scripts/guard/guard-check.sh）の判定で実行を止める（docs/GUARD.md）。
//   置き場所は .opencode/plugins/（opencode が自動で読み込む）。
//   プラグインがツール実行を止める手段は throw のみで、その場で「ユーザーに確認する」口は無い
//   （permission.ask フックは不安定な既知の問題があるため使わない）。
//   そのため核の ask も deny と同じく throw して止め、理由にその旨を書く（fail-closed）。
//   判定できない場合（核を呼べない・核が異常終了した場合）も throw して止める（fail-closed）。
//   核のパスは worktree のルート基準で解決する。directory は起動時の作業ディレクトリで、
//   サブディレクトリから起動してもプラグインは読み込まれるため、directory 基準だと核を見失う。
// 仕様の出典: https://opencode.ai/docs/plugins/（配置と自動読み込み）
//             https://opencode.ai/docs/build/plugins/migrate-v1（V1 の tool.execute.before の形と throw での停止）
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const AgentGuardPlugin = async ({ directory, worktree }) => {
  const core = join(worktree ?? directory, "scripts", "guard", "guard-check.sh")
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output?.args?.command
      if (typeof command !== "string" || command === "") return
      if (!existsSync(core)) {
        throw new Error("[guard] ガードの核（scripts/guard/guard-check.sh）が無いため、安全側に倒してこのコマンドを止めました（.opencode/plugins/agent-guard.js）")
      }
      let result
      try {
        result = spawnSync("bash", [core], { input: command, encoding: "utf8", timeout: 30000 })
      } catch (e) {
        throw new Error(`[guard] ガードの核を呼べないため、安全側に倒してこのコマンドを止めました（.opencode/plugins/agent-guard.js）: ${e.message}`)
      }
      if (result.error) {
        throw new Error(`[guard] ガードの核を呼べないため、安全側に倒してこのコマンドを止めました（.opencode/plugins/agent-guard.js）: ${result.error.message}`)
      }
      let reason = (result.stdout ?? "").trim()
      if (!reason && result.stderr) reason = result.stderr.trim().split("\n")[0]
      if (result.status === 0) return
      if (result.status === 3) {
        throw new Error(`[guard] このコマンドは本来「ユーザーに確認してから」（ask）ですが、opencode のプラグインからは確認を求められないため止めました: ${reason}\n必要なら、理由を添えてユーザーに手動での実行を依頼してください。`)
      }
      throw new Error(`[guard] このコマンドは実行できません: ${reason}\n必要なら、理由を添えてユーザーに手動での実行を依頼してください。`)
    },
  }
}
