#!/usr/bin/env bash
# build-android-apk.sh - Android APK をビルドして Web 配布先へデプロイする
#
# 使い方:
#   bash scripts/build-android-apk.sh              # release ビルド + 配布
#   bash scripts/build-android-apk.sh --debug      # debug ビルドのみ（配布しない）
#   bash scripts/build-android-apk.sh --no-deploy  # ビルドのみ（配布しない）
#
# 何をするか:
#   1. mai_notification/ で gradlew assembleRelease（または assembleDebug）
#   2. release の場合: app-release.apk → webui/mai-notification.apk へコピー
#   3. release の場合: /home/yuzuki/share/ へもコピー（サイドロード用）
#   4. webui/dl/android.json の versionCode/versionName を build.gradle.kts から自動更新
#
# 注意:
#   - webui/mai-notification.apk は gitignore 対象（直接ファイルを置くだけで配布される）
#   - keystore.properties が無いと unsigned APK になる（release 署名には必要）
#   - JAVA_HOME 未設定でも gradlew が JDK を解決する（~/.gradle/jdks/ を使用）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT/mai_notification"
APK_RELEASE="$APP_DIR/app/build/outputs/apk/release/app-release.apk"
APK_DEBUG="$APP_DIR/app/build/outputs/apk/debug/app-debug.apk"
WEB_APK="$ROOT/webui/mai-notification.apk"
SHARE_DIR="/home/yuzuki/share"
ANDROID_JSON="$ROOT/webui/dl/android.json"
AAPT="$HOME/android-sdk/build-tools/36.0.0/aapt"

BUILD_TYPE="release"
DEPLOY=1

for arg in "$@"; do
  case "$arg" in
    --debug)    BUILD_TYPE="debug" ;;
    --no-deploy) DEPLOY=0 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

echo "==> Android APK ビルド ($BUILD_TYPE)"

cd "$APP_DIR"

# gradlew に実行権限が無い場合がある（git checkout で落ちる）
chmod +x gradlew 2>/dev/null || true

if [ "$BUILD_TYPE" = "release" ]; then
  ./gradlew assembleRelease --console=plain
  APK="$APK_RELEASE"
else
  ./gradlew assembleDebug --console=plain
  APK="$APK_DEBUG"
fi

if [ ! -f "$APK" ]; then
  echo "ERROR: APK が見つからない: $APK" >&2
  exit 1
fi

# バージョン情報を取得
# 注意: set -o pipefail 下では aapt | head -1 が SIGPIPE(141) を起こすため
#       head を使わず sed で先頭行のみ取り出す
if [ -x "$AAPT" ]; then
  BADGING=$("$AAPT" dump badging "$APK" 2>/dev/null | sed -n '1p' || true)
  VERSION_NAME=$(echo "$BADGING" | grep -oP "versionName='\K[^']+" || true)
  VERSION_CODE=$(echo "$BADGING" | grep -oP "versionCode='\K[^']+" || true)
  echo "==> ビルド結果: v$VERSION_NAME (versionCode $VERSION_CODE)"
else
  echo "WARN: aapt が見つからないためバージョン確認をスキップ" >&2
  VERSION_NAME=""
  VERSION_CODE=""
fi

if [ "$BUILD_TYPE" != "release" ] || [ "$DEPLOY" -eq 0 ]; then
  echo "==> 配布スキップ: $APK"
  exit 0
fi

# 1) Web 配布先へコピー
cp "$APK" "$WEB_APK"
echo "==> Web 配布へコピー: $WEB_APK ($(stat -c%s "$WEB_APK") bytes)"

# 2) サイドロード用 share へコピー
mkdir -p "$SHARE_DIR"
SHARE_APK="$SHARE_DIR/mai-notification-v${VERSION_NAME}-release.apk"
cp "$APK" "$SHARE_APK"
echo "==> share へコピー: $SHARE_APK"

# 3) android.json を自動更新（versionCode / versionName / url）
if [ -n "$VERSION_NAME" ] && [ -n "$VERSION_CODE" ] && [ -f "$ANDROID_JSON" ]; then
  python3 - "$ANDROID_JSON" "$VERSION_CODE" "$VERSION_NAME" <<'PYEOF'
import json, sys
path, code, name = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)
data["versionCode"] = int(code)
data["versionName"] = name
data["url"] = f"https://koinoyamai.love/mai-notification.apk?v={code}"
with open(path, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"==> android.json 更新: versionCode={code} versionName={name}")
PYEOF
fi

echo ""
echo "完了。コミットが必要な場合は:"
echo "  git add webui/dl/android.json"
echo "  git commit -m \"release(android): v${VERSION_NAME} (versionCode ${VERSION_CODE})\""
echo "  git push"
