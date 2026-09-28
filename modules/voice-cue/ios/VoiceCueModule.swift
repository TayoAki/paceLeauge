import AVFoundation
import ExpoModulesCore

/**
 * Speaks run cues over the runner's music (docs/ROADMAP.md Part C, "Voice cues and music don't clash").
 *
 * While a cue plays, other audio is lowered and spoken audio such as a podcast pauses. When the cue
 * ends, the audio session is released with `.notifyOthersOnDeactivation`, which tells the other app
 * to return to full volume or resume. AVSpeechSynthesizer on its own never does this, which is why
 * music stays quiet after a cue in some apps. A newer cue replaces one still speaking instead of
 * queueing behind it, so cues never arrive late.
 */
public final class VoiceCueModule: Module {
  private var cueSpeaker: CueSpeaker?

  /** Created on first use, on the main queue (every function below runs there). */
  private var speaker: CueSpeaker {
    if let existing = cueSpeaker {
      return existing
    }
    let created = CueSpeaker()
    cueSpeaker = created
    return created
  }

  public func definition() -> ModuleDefinition {
    Name("VoiceCue")

    // Resolves with "spoken", "replaced", "stopped", "unavailable" or "no_headphones"; never
    // rejects, because a missed cue must never interrupt a run.
    AsyncFunction("speak") { (text: String, options: SpeakOptions, promise: Promise) in
      self.speaker.speak(text: text, options: options) { outcome in
        promise.resolve(outcome)
      }
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.speaker.stop()
    }.runOnQueue(.main)

    AsyncFunction("beginRun") {
      self.speaker.beginRun()
    }.runOnQueue(.main)

    OnDestroy {
      let existing = self.cueSpeaker
      DispatchQueue.main.async {
        existing?.stop()
      }
    }
  }
}

struct SpeakOptions: Record {
  @Field
  var volume: Double = 1.0
  /** Speak through the phone speaker after headphones disconnect mid-run. */
  @Field
  var allowSpeaker: Bool = true
  /** Lower other audio while speaking. When false, the cue mixes over it at full volume. */
  @Field
  var duck: Bool = true
  /** BCP-47 language such as "en-US"; the best installed voice for the device language when absent. */
  @Field
  var language: String? = nil
}

final class CueSpeaker: NSObject, AVSpeechSynthesizerDelegate {
  private enum Output {
    case bluetooth, wired, speaker, external
  }

  private static let bluetoothPorts: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
  private static let wiredPorts: Set<AVAudioSession.Port> = [.headphones, .usbAudio]
  private static let speakerPorts: Set<AVAudioSession.Port> = [.builtInSpeaker, .builtInReceiver]

  private let synthesizer = AVSpeechSynthesizer()
  private var current: (utterance: AVSpeechUtterance, done: (String) -> Void)?
  /** Bumped on each cue so late work from an earlier cue can't touch a newer one. */
  private var generation = 0
  /** Headphones were in use at some point this run. */
  private var headphonesSeen = false

  override init() {
    super.init()
    synthesizer.delegate = self
    // Speak through our session so the category and ducking below apply to the cue.
    synthesizer.usesApplicationAudioSession = true
  }

  func beginRun() {
    headphonesSeen = false
  }

  func speak(text: String, options: SpeakOptions, done: @escaping (String) -> Void) {
    cancelCurrent(outcome: "replaced")
    generation += 1
    let mine = generation

    // Headphones came out mid-run: stay quiet rather than talk from the phone's speaker, unless
    // the runner chose the speaker.
    let output = Self.currentOutput()
    if output == .bluetooth || output == .wired {
      headphonesSeen = true
    } else if output == .speaker && headphonesSeen && !options.allowSpeaker {
      release()
      done("no_headphones")
      return
    }

    let session = AVAudioSession.sharedInstance()
    do {
      // .playback speaks even with the ring switch on silent; .voicePrompt tells the system this is
      // a short spoken prompt, like a navigation instruction.
      let categoryOptions: AVAudioSession.CategoryOptions =
        options.duck ? [.duckOthers, .interruptSpokenAudioAndMixWithOthers] : [.mixWithOthers]
      try session.setCategory(.playback, mode: .voicePrompt, options: categoryOptions)
      try session.setActive(true)
    } catch {
      // For example during a phone call. The cue is skipped; the run carries on.
      release()
      done("unavailable")
      return
    }

    let utterance = AVSpeechUtterance(string: text)
    utterance.volume = Float(min(max(options.volume, 0.0), 1.0))
    utterance.voice = Self.bestVoice(language: options.language)
    current = (utterance, done)

    // Bluetooth headphones wake up when audio starts and would clip the first word: switch the
    // audio on a moment before speaking.
    let leadIn: TimeInterval = output == .bluetooth ? 0.3 : 0
    if leadIn == 0 {
      synthesizer.speak(utterance)
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + leadIn) { [weak self] in
      guard let self, self.generation == mine, let active = self.current, active.utterance === utterance else { return }
      self.synthesizer.speak(utterance)
    }
  }

  func stop() {
    if cancelCurrent(outcome: "stopped") {
      release()
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finish(utterance, outcome: "spoken")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finish(utterance, outcome: "stopped")
  }

  @discardableResult
  private func cancelCurrent(outcome: String) -> Bool {
    guard let active = current else { return false }
    current = nil
    synthesizer.stopSpeaking(at: .immediate)
    active.done(outcome)
    return true
  }

  private func finish(_ utterance: AVSpeechUtterance, outcome: String) {
    // A cancel for a cue that a newer one replaced arrives after the newer one started: ignore it.
    guard let active = current, active.utterance === utterance else { return }
    current = nil
    active.done(outcome)
    release()
  }

  /** Hands the audio back so the runner's music returns to full volume. */
  private func release() {
    let releasing = generation
    // A short delay lets the last syllable finish playing out of the audio buffer.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
      guard let self, self.current == nil, self.generation == releasing else { return }
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  private static func currentOutput() -> Output {
    let ports = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType)
    if ports.contains(where: { bluetoothPorts.contains($0) }) {
      return .bluetooth
    }
    if ports.contains(where: { wiredPorts.contains($0) }) {
      return .wired
    }
    if ports.contains(where: { speakerPorts.contains($0) }) {
      return .speaker
    }
    return .external
  }

  /**
   * The highest-quality installed voice for the language: premium, then enhanced, then the system
   * default. Novelty voices and the runner's Personal Voice are never picked.
   */
  private static func bestVoice(language: String?) -> AVSpeechSynthesisVoice? {
    let wanted = language ?? AVSpeechSynthesisVoice.currentLanguageCode()
    let systemDefault = AVSpeechSynthesisVoice(language: wanted)
    var candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == wanted }
    if #available(iOS 17.0, *) {
      candidates = candidates.filter { !$0.voiceTraits.contains(.isNoveltyVoice) && !$0.voiceTraits.contains(.isPersonalVoice) }
    }
    guard let top = candidates.map(\.quality.rawValue).max() else { return systemDefault }
    if let systemDefault, systemDefault.quality.rawValue >= top { return systemDefault }
    return candidates.first { $0.quality.rawValue == top } ?? systemDefault
  }
}
