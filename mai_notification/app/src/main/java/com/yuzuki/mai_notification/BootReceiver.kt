package com.yuzuki.mai_notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 端末の再起動後にアラームを予約し直す。
 *
 * Android は再起動で AlarmManager のアラームをすべて消すため、
 * 再起動を検知してスケジュールを取り直さないとアラームが失效する。
 * （公式ドキュメント「Start an alarm when the device restarts」）
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Log.i(TAG, "再起動/更新を検知: アラームを再登録します")
        try {
            AlarmScheduler.rescheduleFromServer(context)
        } catch (e: Exception) {
            Log.w(TAG, "アラーム再登録に失敗: ${e.message}")
        }
    }
}
