import AVFoundation

/**
 * Voice cues on the watch (docs/ROADMAP.md 2.2 and Part C): spoken through the watch speaker or its
 * AirPods, lowering music while they speak and handing the audio back afterwards.
 */
final class CueSpeaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func say(_ text: String) {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
      try session.setActive(true)
    } catch {
      return
    }
    synthesizer.speak(AVSpeechUtterance(string: text))
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
