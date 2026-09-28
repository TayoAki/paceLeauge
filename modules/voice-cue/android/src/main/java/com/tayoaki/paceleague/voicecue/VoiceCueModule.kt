package com.tayoaki.paceleague.voicecue

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.Locale

class SpeakOptions(
  @Field var volume: Double = 1.0,
  /** Speak through the phone speaker after headphones disconnect mid-run. */
  @Field var allowSpeaker: Boolean = true,
  /** Lower other audio while speaking. When false, the cue plays over it at full volume. */
  @Field var duck: Boolean = true,
  /** BCP-47 language such as "en-US"; the device language when absent. */
  @Field var language: String? = null
) : Record

/**
 * Speaks run cues over the runner's music (docs/ROADMAP.md Part C). Each cue takes transient,
 * may-duck audio focus, so music lowers and podcasts pause for the length of the cue, and gives
 * focus back afterwards so the other app returns to full volume. A newer cue replaces one still
 * speaking. `speak` resolves with "spoken", "replaced", "stopped", "unavailable" or
 * "no_headphones" and never rejects: a missed cue must never interrupt a run.
 */
class VoiceCueModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var tts: TextToSpeech? = null
  private var ttsState = TtsState.IDLE
  private var waiting: Triple<String, SpeakOptions, Promise>? = null
  private var current: Pair<String, Promise>? = null
  private var focusRequest: AudioFocusRequest? = null
  private var nextId = 0
  /** Headphones were in use at some point this run. */
  private var headphonesSeen = false

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val attributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  // Focus changes while a cue speaks need no action: the cue is a few seconds long.
  private val focusListener = AudioManager.OnAudioFocusChangeListener { }

  override fun definition() = ModuleDefinition {
    Name("VoiceCue")

    AsyncFunction("speak") { text: String, options: SpeakOptions, promise: Promise ->
      speak(text, options, promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      stopCurrent("stopped")
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("beginRun") {
      headphonesSeen = false
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      main.post {
        stopCurrent("stopped")
        waiting?.third?.resolve("stopped")
        waiting = null
        tts?.shutdown()
        tts = null
        ttsState = TtsState.IDLE
      }
    }
  }

  private fun speak(text: String, options: SpeakOptions, promise: Promise) {
    when (ttsState) {
      TtsState.READY -> speakNow(text, options, promise)
      TtsState.FAILED -> promise.resolve("unavailable")
      TtsState.STARTING -> {
        waiting?.third?.resolve("replaced")
        waiting = Triple(text, options, promise)
      }
      TtsState.IDLE -> {
        waiting = Triple(text, options, promise)
        startEngine()
      }
    }
  }

  private fun startEngine() {
    ttsState = TtsState.STARTING
    tts = TextToSpeech(context) { status ->
      main.post { onEngineReady(status == TextToSpeech.SUCCESS) }
    }
  }

  private fun onEngineReady(ok: Boolean) {
    val engine = tts
    if (!ok || engine == null) {
      ttsState = TtsState.FAILED
      waiting?.third?.resolve("unavailable")
      waiting = null
      return
    }
    ttsState = TtsState.READY
    engine.setAudioAttributes(attributes)
    engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String) {}

      override fun onDone(utteranceId: String) {
        main.post { finish(utteranceId, "spoken") }
      }

      override fun onStop(utteranceId: String, interrupted: Boolean) {
        main.post { finish(utteranceId, "stopped") }
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String) {
        main.post { finish(utteranceId, "unavailable") }
      }

      override fun onError(utteranceId: String, errorCode: Int) {
        main.post { finish(utteranceId, "unavailable") }
      }
    })
    waiting?.let { (text, options, promise) ->
      waiting = null
      speakNow(text, options, promise)
    }
  }

  private fun speakNow(text: String, options: SpeakOptions, promise: Promise) {
    val engine = tts ?: return promise.resolve("unavailable")
    current?.let { (_, previous) ->
      current = null
      engine.stop()
      previous.resolve("replaced")
    }

    // Headphones came out mid-run: stay quiet rather than talk from the phone's speaker, unless
    // the runner chose the speaker.
    val output = currentOutput()
    if (output == Output.BLUETOOTH || output == Output.WIRED) {
      headphonesSeen = true
    } else if (headphonesSeen && !options.allowSpeaker) {
      abandonFocus()
      promise.resolve("no_headphones")
      return
    }

    if (options.duck && !requestFocus()) {
      // For example during a phone call. The cue is skipped; the run carries on.
      abandonFocus()
      promise.resolve("unavailable")
      return
    }
    options.language?.let { tag ->
      val locale = Locale.forLanguageTag(tag)
      val available = engine.isLanguageAvailable(locale)
      if (available != TextToSpeech.LANG_MISSING_DATA && available != TextToSpeech.LANG_NOT_SUPPORTED) {
        engine.language = locale
      }
    }
    val params = Bundle().apply {
      putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, options.volume.coerceIn(0.0, 1.0).toFloat())
    }
    nextId += 1
    val id = "cue-$nextId"
    current = Pair(id, promise)

    val say = Runnable {
      // QUEUE_FLUSH: the newest cue replaces one still speaking instead of arriving late.
      if (current?.first == id && engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) {
        finish(id, "unavailable")
      }
    }
    // Bluetooth headphones wake up when audio starts and would clip the first word: take focus a
    // moment before speaking.
    if (output == Output.BLUETOOTH) {
      main.postDelayed(say, 300)
    } else {
      say.run()
    }
  }

  private fun finish(utteranceId: String, outcome: String) {
    val active = current ?: return
    if (active.first != utteranceId) return
    current = null
    active.second.resolve(outcome)
    abandonFocus()
  }

  private fun stopCurrent(outcome: String) {
    val active = current ?: return
    current = null
    tts?.stop()
    active.second.resolve(outcome)
    abandonFocus()
  }

  private fun requestFocus(): Boolean {
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(focusListener, main)
        .build()
        .also { focusRequest = it }
      audioManager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    }
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  /** Gives focus back so the runner's music returns to full volume. */
  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(focusListener)
    }
  }

  @SuppressLint("InlinedApi")
  private fun currentOutput(): Output {
    val types = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }.toSet()
    val bluetooth = setOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_HEARING_AID
    )
    val wired = setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_USB_HEADSET
    )
    return when {
      types.any { it in bluetooth } -> Output.BLUETOOTH
      types.any { it in wired } -> Output.WIRED
      else -> Output.SPEAKER
    }
  }

  private enum class Output {
    BLUETOOTH,
    WIRED,
    SPEAKER
  }

  private enum class TtsState {
    IDLE,
    STARTING,
    READY,
    FAILED
  }
}
