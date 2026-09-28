package com.tayoaki.paceleague.launchintent

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The action of the intent that opened the app. Health Connect opens apps with its "show
 * permissions rationale" actions when someone taps the privacy-policy link on its permission
 * screen; the app shows its Privacy Policy for them (docs/ROADMAP.md P.1).
 */
class LaunchIntentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaunchIntent")

    Events("onIntent")

    Function("initialAction") {
      appContext.currentActivity?.intent?.action
    }

    OnNewIntent { intent: Intent ->
      sendEvent("onIntent", mapOf("action" to intent.action))
    }
  }
}
