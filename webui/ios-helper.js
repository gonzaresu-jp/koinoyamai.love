// /pushweb/ios-helper.js - iOS専用ヘルパーモジュール

class IOSHelper {
    constructor() {
        this.isIOS = this.detectIOS();
        this.isPWA = this.detectPWA();
        this.isIOSChrome = this.detectIOSChrome();
    }

    // iOS検出
    detectIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    // PWAモード（ホーム画面から起動）検出
    detectPWA() {
        return window.navigator.standalone === true || 
               window.matchMedia('(display-mode: standalone)').matches;
    }

    // iOS版Chrome検出
    detectIOSChrome() {
        return /CriOS/.test(navigator.userAgent);
    }

    // Push通知が利用可能か
    isPushAvailable() {
        if (!this.isIOS) {
            // iOS以外は通常の判定
            return 'serviceWorker' in navigator && 'PushManager' in window;
        }

        // iOSの場合はPWAモードが必須
        return this.isPWA && 'serviceWorker' in navigator && 'PushManager' in window;
    }

    // インストールガイドを表示すべきか
    shouldShowInstallGuide() {
        if (!this.isIOS) return false;
        if (this.isPWA) return false;
        if (this.isIOSChrome) return false; // ChromeではPWAインストール不可
        
        const guideShown = localStorage.getItem('ios-guide-shown');
        if (guideShown) return false;
        
        // 既に通知がONの場合は表示しない
        const pushSubscription = localStorage.getItem('pushSubscription');
        if (pushSubscription) {
            console.log('[iOS Helper] 通知ON済みのためガイド非表示');
            return false;
        }
        
        return true;
    }

    // インストールガイドを表示
    showInstallGuide() {
        const guideHTML = `
            <div id="ios-notification-guide" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 10000; padding: 20px; overflow-y: auto;">
                <div style="background: white; border-radius: 12px; padding: 24px; max-width: 400px; margin: 40px auto;">
                    <h2 style="margin-top: 0; color: #333;">iOS通知設定ガイド</h2>
                    
                    <div style="margin: 20px 0;">
                        <p><strong>ステップ1:</strong> Safariの共有ボタン <span style="font-size: 20px;">⎙</span> をタップ</p>
                        <p><strong>ステップ2:</strong> 「ホーム画面に追加」を選択</p>
                        <p><strong>ステップ3:</strong> 「追加」をタップしてインストール</p>
                        <p><strong>ステップ4:</strong> ホーム画面のアイコンからアプリを開く</p>
                        <p><strong>ステップ5:</strong> 右上のハンバーガーメニューを開いて通知をオンにする</p>
                        <p><strong>ステップ6:</strong> 通知の許可を求められたら「許可」をタップ</p>
                        <p><strong>ステップ7:</strong> テスト通知を押して通知が届くか確認する</p>
                    </div>
                    
                    <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 12px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 14px; color: #856404;">
                            ⚠️ <strong>重要:</strong> iOSでは、ホーム画面に追加したアプリからのみ通知を受け取れます。Safariブラウザからは通知を受け取れません。
                        </p>
                    </div>
                    
                    <button id="ios-guide-close" style="width: 100%; padding: 12px; background: #B11E7C; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">
                        閉じる
                    </button>
                </div>
            </div>
        `;

        const guideEl = document.createElement('div');
        guideEl.innerHTML = guideHTML;
        document.body.appendChild(guideEl);

        const closeBtn = document.getElementById('ios-guide-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                guideEl.remove();
                localStorage.setItem('ios-guide-shown', 'true');
            });
        }
    }

    // 通知がブロックされている場合の案内
    showNotificationBlockedWarning() {
        if (!this.isIOS || !this.isPWA) return;
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'denied') return;

        const statusEl = document.getElementById('status');
        if (!statusEl) return;

        const warningHTML = `
            <div style="background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 8px; padding: 16px; margin: 20px 0;">
                <p style="margin: 0; color: #721c24;">
                    <strong>⚠️ 通知がブロックされています</strong><br>
                    iOSの設定アプリ → このアプリ → 通知 から通知を許可してください。
                </p>
            </div>
        `;

        statusEl.insertAdjacentHTML('afterbegin', warningHTML);
    }

    // 通知初期化（iOS対応版）
    async initPushNotification(initPushFunction) {
        if (!this.isPushAvailable()) {
            if (this.isIOS && !this.isPWA) {
                throw new Error('iOS_PWA_REQUIRED');
            }
            throw new Error('Push通知に対応していません');
        }

        try {
            return await initPushFunction();
        } catch (error) {
            console.error('iOS Push初期化エラー:', error);
            throw error;
        }
    }

    // デバッグ情報
    getDebugInfo() {
        return {
            isIOS: this.isIOS,
            isPWA: this.isPWA,
            isIOSChrome: this.isIOSChrome,
            isPushAvailable: this.isPushAvailable(),
            notificationPermission: 'Notification' in window ? Notification.permission : 'not_supported',
            userAgent: navigator.userAgent
        };
    }
}

// シングルトンとしてエクスポート
const iosHelper = new IOSHelper();
// クラシック script のトップレベル `const` は window に載らない。
// バンドル（ES module）から確実に参照できるよう明示的に公開する（2026-10-23）。
// ※ この公開が無いとガイドが「読まれるだけのデッドコード」のままになる。
if (typeof window !== 'undefined') window.iosHelper = iosHelper;

// デバッグ用
console.log('[iOS Helper] 初期化完了:', iosHelper.getDebugInfo());
